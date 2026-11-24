'use strict';
// Bun's fetch and WebSocket `proxy`, and the proxy environment Bun's fetch reads by itself, under quaude: the same
// requests, through the same recording proxy, as native Claude Code's Bun makes them (2026-11-23).
//
// WHAT WAS WRONG. Native Claude Code passes `proxy` to fetch whenever a proxy is configured (HTTPS_PROXY & co: a URL,
// or { url, headers: { 'Proxy-Authorization': <proxyAuthHelper> } }), `proxy: false` where it wants none, and leaves
// the rest to Bun's own reading of the environment. bun-shim first IGNORED the key (every such request went direct,
// past a corporate proxy), then REFUSED it by name (every API request behind a proxy failed). The engine's own proxy
// support (txiki's lws vhosts) read the environment once, at start, tunnelled even plain http through CONNECT, named
// the target by IP address in the CONNECT (it resolved the target locally first, which a proxy-only network cannot
// do), and could send no Proxy-Authorization but Basic-from-userinfo.
//
// NOW: the engine routes each connection as it is told (spike/quickjs/patches/txiki-fetch-proxy.patch and
// lws-proxy-connect.patch: an absolute-form request for http, a CONNECT carrying exactly the caller's header block for
// https and for WebSocket, the proxy's status line on a refusal), and bun-shim decides the route in Bun's terms
// (libexec/bun-shim.cjs _bunProxyPolicy), per redirect hop.
//
// THE RATCHET: test/fixtures/fetch-proxy-rows.cjs, recorded under native Bun (fetch-proxy-native.json) and run here
// under the shim, compared row by row: what the caller got AND what arrived at the proxy. Re-record with
//   FETCH_PROXY_RECORD=<native claude binary> node test/run.mjs test/fetch-proxy.test.cjs
// (a throwaway HOME; the preload exits before Claude Code starts, so no credentials, no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { testPki } = require('./self-signed-cert.cjs');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const FIX = path.join(__dirname, 'fixtures');
const ROWS = path.join(FIX, 'fetch-proxy-rows.cjs');
const NATIVE = path.join(FIX, 'fetch-proxy-native.json');
const BUN_SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function start(script, args = [], env = {}) {
  const proc = spawn(process.execPath, [path.join(FIX, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${script} printed no PORT line: ${err}`)); }, 15000);
    proc.stdout.on('data', (d) => { buf += d; const m = /PORT (\d+)/.exec(buf); if (m) { clearTimeout(timer); resolve({ proc, port: Number(m[1]) }); } });
    proc.on('close', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code}): ${err}`)); });
  });
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// The servers every row needs, all under host node (the fixed point): -> { P, dir, stop }
async function servers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-proxy-'));
  const procs = [];
  const stop = () => { for (const p of procs) p.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    const pki = testPki(dir);
    const log = path.join(dir, 'proxy.log');
    fs.writeFileSync(log, '');
    const up = async (...a) => { const s = await start(...a); procs.push(s.proc); return s.port; };
    const P = {
      log, ca: pki.ca.cert, ca2: pki.ca2.cert,
      http: await up('options-census-origin.cjs'),
      https: await up('https-client-origin.cjs', [pki.leaf.cert, pki.leaf.key]),
      open: await up('proxy-server.cjs', [], { PROXY_LOG: log }),
      auth: await up('proxy-server.cjs', [], { PROXY_LOG: log, PROXY_AUTH: 'u:p' }),
      dead: await freePort(),
    };
    return { P, dir, stop };
  } catch (e) { stop(); throw e; }
}
const lastJson = (s) => JSON.parse(String(s).trim().split('\n').pop());
function haveOpenssl(t) {
  if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0) return true;
  t.skip('no openssl on PATH; cannot mint the test certificates');
  return false;
}

// Under the shim: the rows file with bun-shim loaded first, as a built quaude loads it.
function runShim(P, dir, prelude = '') {
  const f = path.join(dir, 'rows.cjs');
  fs.writeFileSync(f, `${prelude}require(${JSON.stringify(BUN_SHIM)});\nrequire(${JSON.stringify(ROWS)});\n`);
  const r = runLoader(f, [], { env: { PROXY_ROWS: JSON.stringify(P) }, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return lastJson(r.stdout);
}

test('proxy rows: every row answers under the shim as native Bun answered it', async (t) => {
  if (process.platform === 'win32') { t.skip('the recording is POSIX-shaped (loopback names, /bin/sh-free but unmeasured there)'); return; }
  if (!haveOpenssl(t)) return;
  const record = process.env.FETCH_PROXY_RECORD;
  if (!record && skipUnlessTjs(t)) return;
  const { P, dir, stop } = await servers();
  try {
    if (record) {
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      const out = path.join(dir, 'native.json');
      const r = spawnSync(record, ['--version'], {
        encoding: 'utf8', timeout: 180000,
        env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PROXY_ROWS: JSON.stringify(P), OUTF: out,
          BUN_OPTIONS: `--preload ${ROWS}` },
      });
      // an empty or missing OUTF means the preload was ignored: a refusal, never a pass
      assert.ok(fs.existsSync(out) && fs.statSync(out).size > 2, `the native preload wrote nothing: ${r.stderr}`);
      const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
      // the preload exits before Claude Code prints its version: ask again without it
      const version = String(spawnSync(record, ['--version'], { encoding: 'utf8', timeout: 60000,
        env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }).stdout).trim();
      fs.writeFileSync(NATIVE, `${JSON.stringify({ _recorded: `${new Date().toISOString().slice(0, 10)}, native ${version}, `
        + `${process.platform}-${process.arch}, preload of test/fixtures/fetch-proxy-rows.cjs (host node ${process.version})`, ...rows }, null, 1)}\n`);
      t.diagnostic(`re-recorded ${NATIVE}`);
      return;
    }
    const { _recorded, ...native } = JSON.parse(fs.readFileSync(NATIVE, 'utf8'));
    const shim = runShim(P, dir);
    const differ = Object.keys(native).filter((k) => JSON.stringify(native[k]) !== JSON.stringify(shim[k]));
    assert.deepStrictEqual(differ.map((k) => ({ row: k, native: native[k], shim: shim[k] })), [], 'rows where quaude does not do what native Bun does');
    assert.deepStrictEqual(Object.keys(shim).sort(), Object.keys(native).sort(), 'the rows file and the native recording disagree on the rows');
  } finally { stop(); }
});

// What native does and quaude cannot: TLS to the proxy itself (an https:// proxy URL). Refused by name, before
// anything is sent; and an engine without the proxy routes refuses an explicit proxy the same way (the floor).
test('proxy refusals: an https:// proxy, and an engine without proxy routes, refuse by name and send nothing', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-shaped like the rows'); return; }
  if (skipUnlessTjs(t) || !haveOpenssl(t)) return;
  const { P, dir, stop } = await servers();
  try {
    const f = path.join(dir, 'refuse.cjs');
    fs.writeFileSync(f, `require(${JSON.stringify(BUN_SHIM)});
const fs = require('fs');
const P = JSON.parse(process.env.PROXY_ROWS);
const H = 'http://127.0.0.1:' + P.http + '/echo';
const arrived = () => fs.readFileSync(P.log, 'utf8').length > 0;
(async () => {
  const out = {};
  out.httpsProxy = await fetch(H, { proxy: 'https://127.0.0.1:' + P.open }).then(() => 'NOT REFUSED', (e) => e.code + ' ' + e.option);
  process.env.HTTP_PROXY = 'https://127.0.0.1:' + P.open;
  out.httpsProxyEnv = await fetch(H).then(() => 'NOT REFUSED', (e) => e.code + ' ' + e.option);
  delete process.env.HTTP_PROXY;
  try { new WebSocket('ws://127.0.0.1:' + P.http + '/', { proxy: 'https://127.0.0.1:' + P.open }); out.wsHttpsProxy = 'NOT REFUSED'; } catch (e) { out.wsHttpsProxy = e.code + ' ' + e.option; }
  const routes = Object.getOwnPropertyDescriptor(globalThis, '__tjs_proxy_routes');
  delete globalThis.__tjs_proxy_routes;
  out.engineFloor = await fetch(H, { proxy: 'http://127.0.0.1:' + P.open }).then(() => 'NOT REFUSED', (e) => e.code + ' ' + e.option);
  try { new WebSocket('ws://127.0.0.1:' + P.http + '/', { proxy: 'http://127.0.0.1:' + P.open }); out.wsEngineFloor = 'NOT REFUSED'; } catch (e) { out.wsEngineFloor = e.code + ' ' + e.option; }
  if (routes) Object.defineProperty(globalThis, '__tjs_proxy_routes', routes);
  out.arrived = arrived();
  console.log(JSON.stringify(out));
  process.exit(0);
})();
`);
    const r = runLoader(f, [], { env: { PROXY_ROWS: JSON.stringify(P) }, timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const refused = 'ERR_CLODE_UNSUPPORTED_OPTION proxy';
    assert.deepStrictEqual(lastJson(r.stdout), { httpsProxy: refused, httpsProxyEnv: refused, wsHttpsProxy: refused,
      engineFloor: refused, wsEngineFloor: refused, arrived: false });
  } finally { stop(); }
});

// The TLS inside a CONNECT tunnel is verified exactly as a direct connection's: against the default trust that
// tls.setDefaultCACertificates (and, in a built quaude, NODE_EXTRA_CA_CERTS) sets. Shim-only, because native Bun's
// fetch does not read that default (it reads tls.ca per request, which the rows above pass).
test('proxy tunnel TLS: verified against the default trust, exactly as a direct request is', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-shaped like the rows'); return; }
  if (skipUnlessTjs(t) || !haveOpenssl(t)) return;
  const { P, dir, stop } = await servers();
  try {
    const f = path.join(dir, 'trust.cjs');
    fs.writeFileSync(f, `require(${JSON.stringify(BUN_SHIM)});
const fs = require('fs'); const tls = require('tls');
const P = JSON.parse(process.env.PROXY_ROWS);
const S = 'https://127.0.0.1:' + P.https + '/x';
const PX = 'http://127.0.0.1:' + P.open;
const one = (init) => fetch(S, { keepalive: false, ...init }).then((r) => r.status, (e) => 'failed: ' + e.message);
(async () => {
  const out = {};
  tls.setDefaultCACertificates([fs.readFileSync(P.ca2, 'utf8')]);
  out.otherCa = { direct: await one({}), tunnel: await one({ proxy: PX }) };
  tls.setDefaultCACertificates([fs.readFileSync(P.ca, 'utf8')]);
  out.ca = { direct: await one({}), tunnel: await one({ proxy: PX }) };
  out.connects = fs.readFileSync(P.log, 'utf8').split('\\n').filter((l) => l.includes('CONNECT')).length;
  console.log(JSON.stringify(out));
  process.exit(0);
})();
`);
    const r = runLoader(f, [], { env: { PROXY_ROWS: JSON.stringify(P) }, timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = lastJson(r.stdout);
    assert.match(String(out.otherCa.direct), /^failed: /, 'a CA that did not sign the server: the direct request fails');
    assert.strictEqual(out.otherCa.tunnel, out.otherCa.direct, 'and the tunnelled one fails the same way');
    assert.deepStrictEqual(out.ca, { direct: 200, tunnel: 200 }, 'the CA that signed it: both succeed');
    assert.strictEqual(out.connects, 2, 'both tunnelled requests went through the proxy');
  } finally { stop(); }
});

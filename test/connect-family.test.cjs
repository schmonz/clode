'use strict';
// A name with an address of each family (localhost: ::1 and 127.0.0.1), and a server on one of them: every client
// quaude provides connects as its reference does (2026-11-24).
//
// WHAT WAS WRONG. Native Bun's fetch and WebSocket, and node's http/https clients, try a name's addresses in the
// resolver's order and go on to the next when a connection is refused. Under quaude, fetch went on only when lws refused
// to START a connection, so a fetch to localhost (::1 first on darwin) of a server listening on 127.0.0.1 only failed
// ECONNREFUSED; and WebSocket left the name to lws's own resolver, which asked for A records only, so a WebSocket to
// localhost never reached a server on ::1, and reached a server on both families by IPv4 where native reaches ::1.
// node-shim's http/https already connected as node does (internal/connect-multiple.cjs); its net.connect and
// tls.connect are throwing stubs, so they have no rows.
//
// NOW: the engine resolves fetch's and WebSocket's names with the system resolver and tries each address in turn while
// connect() fails (spike/quickjs/patches/txiki-connect-next-address.patch, scripts/build-tjs.cjs
// fixupHttpclientAsyncDns).
//
// THE RATCHET: test/fixtures/family-rows.cjs against test/fixtures/family-origin.cjs, its answers recorded under
// native Bun (the bun rows) and host node 24 (the node rows) in test/fixtures/connect-family-native.json, and run here
// under the shim, compared row by row. Re-record with
//   CONNECT_FAMILY_RECORD=<native claude binary> node test/run.mjs test/connect-family.test.cjs
// (a throwaway HOME; the preload exits before Claude Code starts, so no credentials, no network).
//
// NOT MEASURED: an address that never answers (a blackhole) before a live one. node gives each address but the last
// 250 ms; the engine waits out lws's connect timeout. No name resolving to such a pair can be made without editing the
// system resolver, so native Bun's timing is unknown.
const test = require('node:test');
const assert = require('node:assert');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { testPki } = require('./self-signed-cert.cjs');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const FIX = path.join(__dirname, 'fixtures');
const ROWS = path.join(FIX, 'family-rows.cjs');
const NATIVE = path.join(FIX, 'connect-family-native.json');
const BUN_SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function haveOpenssl(t) {
  if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0) return true;
  t.skip('no openssl on PATH; cannot mint the test certificates');
  return false;
}

// The host resolver's families for localhost, in its order: ['v6', 'v4'] or ['v4', 'v6'], or null when it does not
// give one address of each (the rows mean nothing there).
async function localhostOrder() {
  let all;
  try { all = await dns.promises.lookup('localhost', { all: true, order: 'verbatim' }); } catch (_) { return null; }
  const fams = [...new Set(all.map((a) => (a.family === 6 ? 'v6' : 'v4')))];
  const addrs = new Set(all.map((a) => a.address));
  return fams.length === 2 && addrs.has('::1') && addrs.has('127.0.0.1') ? fams : null;
}

// The origin (host node, the fixed point) -> { F (FAMILY_ROWS), dir, stop }
async function origin(order, groups) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-family-'));
  let proc = null;
  const stop = () => { if (proc) proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    const pki = testPki(dir);
    proc = spawn(process.execPath, [path.join(FIX, 'family-origin.cjs'), pki.leaf.cert, pki.leaf.key], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const P = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`family-origin printed no PORTS line: ${err}`)), 15000);
      proc.stdout.on('data', (d) => { buf += d; const m = /PORTS (.*)\n/.exec(buf); if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); } });
      proc.on('close', (code) => { clearTimeout(timer); reject(new Error(`family-origin exited (${code}): ${err}`)); });
    });
    const F = { ports: { first: P[order[0]], second: P[order[1]], both: P.dual }, order, ca: pki.ca.cert, groups };
    return { F, dir, stop };
  } catch (e) { stop(); throw e; }
}
const lastJson = (s) => JSON.parse(String(s).trim().split('\n').pop());

test('connect family: every client reaches a name\'s addresses as its reference does', async (t) => {
  if (process.platform === 'win32') { t.skip('recorded on POSIX; Windows\'s localhost resolution is unmeasured'); return; }
  if (!haveOpenssl(t)) return;
  const order = await localhostOrder();
  if (!order) { t.skip('localhost does not resolve to both ::1 and 127.0.0.1 here, so no row can tell a client\'s choice'); return; }
  const record = process.env.CONNECT_FAMILY_RECORD;
  if (!record && skipUnlessTjs(t)) return;
  if (record) {
    // the node rows under this host node (24, the reference), the bun rows under native Bun
    assert.match(process.version, /^v24\./, 'the node rows are recorded under node 24');
    const n = await origin(order, ['node']);
    let nodeRows;
    try {
      const r = spawnSync(process.execPath, [ROWS], { encoding: 'utf8', timeout: 120000, env: { ...process.env, FAMILY_ROWS: JSON.stringify(n.F) } });
      assert.strictEqual(r.status, 0, r.stderr);
      nodeRows = lastJson(r.stdout);
    } finally { n.stop(); }
    const b = await origin(order, ['bun']);
    try {
      const home = path.join(b.dir, 'home');
      fs.mkdirSync(home);
      const out = path.join(b.dir, 'native.json');
      const r = spawnSync(record, ['--version'], {
        encoding: 'utf8', timeout: 180000,
        env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAMILY_ROWS: JSON.stringify(b.F), OUTF: out,
          BUN_OPTIONS: `--preload ${ROWS}` },
      });
      // an empty or missing OUTF means the preload was ignored: a refusal, never a pass
      assert.ok(fs.existsSync(out) && fs.statSync(out).size > 2, `the native preload wrote nothing: ${r.stderr}`);
      const bunRows = JSON.parse(fs.readFileSync(out, 'utf8'));
      const version = String(spawnSync(record, ['--version'], { encoding: 'utf8', timeout: 60000,
        env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }).stdout).trim();
      fs.writeFileSync(NATIVE, `${JSON.stringify({ _recorded: `${new Date().toISOString().slice(0, 10)}, bun rows under native ${version}, `
        + `node rows under host node ${process.version}, ${process.platform}-${process.arch}, localhost resolving ${order.join(' then ')}`,
      ...bunRows, ...nodeRows }, null, 1)}\n`);
      t.diagnostic(`re-recorded ${NATIVE}`);
    } finally { b.stop(); }
    return;
  }
  const { _recorded, ...native } = JSON.parse(fs.readFileSync(NATIVE, 'utf8'));
  const { F, dir, stop } = await origin(order, ['bun', 'node']);
  try {
    const f = path.join(dir, 'rows.cjs');
    fs.writeFileSync(f, `require(${JSON.stringify(BUN_SHIM)});\nrequire(${JSON.stringify(ROWS)});\n`);
    const r = runLoader(f, [], { env: { FAMILY_ROWS: JSON.stringify(F) }, timeout: 180000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const shim = lastJson(r.stdout);
    const differ = Object.keys(native).filter((k) => JSON.stringify(native[k]) !== JSON.stringify(shim[k]));
    assert.deepStrictEqual(differ.map((k) => ({ row: k, reference: native[k], shim: shim[k] })), [],
      `rows where quaude does not connect as its reference does (recorded ${_recorded})`);
    assert.deepStrictEqual(Object.keys(shim).sort(), Object.keys(native).sort(), 'the rows file and the recording disagree on the rows');
  } finally { stop(); }
});

'use strict';
// node:http / node:https CLIENT surface — characterized DIFFERENTIALLY: one
// probe script runs unchanged under host node (the oracle) and under tjs via
// the node-shim loader, both talking to the SAME origin server, and the JSON
// results must deep-equal.
//
// WHY THIS EXISTS AT ALL — measured, not assumed. The client half was a
// documented wall ("the -p transport is fetch"). That was tested by giving the
// shim's http module a logging throw, fusing a quaude and driving real flows:
//   - plain `-p` turn, interactive TUI boot, MCP over HTTP and over SSE, and a
//     run with HTTP(S)_PROXY set: ZERO reaches. axios (the bundle's only heavy
//     node:http user under real node) picks its XHR adapter under tjs, because
//     txiki defines a global XMLHttpRequest and axios prefers ['xhr','http',
//     'fetch']; those requests all succeed today.
//   - CLAUDE_CODE_USE_BEDROCK=1: 10 http.request calls to the EC2 instance
//     metadata service from the AWS SDK credential chain, and (with static
//     credentials) an https.request to bedrock.<region>.amazonaws.com from
//     @smithy/node-http-handler. Host node degrades to "Could not load
//     credentials from any providers"; quaude printed "API Error: <nameless>
//     is not a function".
// So the client is REACHABLE on a supported backend, and the rows below are
// shaped by what those two callers actually do (see also the full divergence
// list in libexec/node-shim/modules/http.cjs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');

// Start an origin fixture (always host node — it is the oracle's fixed point)
// and wait for the `PORT <n>` line it prints once listening.
function startOrigin(script, args = []) {
  const proc = spawn(process.execPath, [path.join(FIXTURES, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${script} never printed a PORT line; stderr:\n${stderr}`)), 15000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (!m) return;
      clearTimeout(timer);
      resolve({ proc, port: Number(m[1]) });
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited early (${code}); stderr:\n${stderr}`)); });
  });
}

function bothEngines(probe, env, t) {
  const probePath = path.join(FIXTURES, probe);
  const n = spawnSync(process.execPath, [probePath], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  assert.strictEqual(n.status, 0, `host node oracle failed:\n${n.stderr}`);
  const r = runLoader(probePath, [], { env, timeout: 60000 });
  assert.strictEqual(r.status, 0, `tjs probe failed:\n${r.stderr}`);
  return [JSON.parse(n.stdout), JSON.parse(r.stdout)];
}

test('http client differential: 23 behaviours identical tjs vs host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const { proc, port } = await startOrigin('http-client-origin.cjs');
  try {
    const [node, shim] = bothEngines('http-client-probe.cjs', { PROBE_PORT: String(port) }, t);
    // Compare per-row so a failure names the behaviour, not "objects differ".
    for (const key of Object.keys(node)) {
      assert.deepStrictEqual(shim[key], node[key], `http client row '${key}' diverged tjs vs node`);
    }
    assert.deepStrictEqual(Object.keys(shim).sort(), Object.keys(node).sort());
  } finally { proc.kill(); }
});

// TLS needs a certificate; openssl is the only cert generator this repo can
// count on, so the row SKIPS (loudly, not silently passing) without it.
test('https client differential: TLS handshake, CA, SNI, rejectUnauthorized', async (t) => {
  if (skipUnlessTjs(t)) return;
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (openssl.status !== 0) { t.skip('no openssl on PATH; cannot mint a test certificate'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpsc-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const { proc, port } = await startOrigin('https-client-origin.cjs', [cert, key]);
  try {
    const [node, shim] = bothEngines('https-client-probe.cjs', { PROBE_PORT: String(port), PROBE_CA: cert }, t);
    for (const k of Object.keys(node)) assert.deepStrictEqual(shim[k], node[k], `https client row '${k}' diverged`);
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The client's UNSUPPORTED options must throw a NAMED, greppable error rather
// than being ignored. This is deliberately NOT differential: host node accepts
// all of these, so the point is to pin the shim's loud refusal — a silently
// ignored socketPath/createConnection would send bytes somewhere the caller
// never asked for, which is exactly the "plausible-looking wrong value" class
// of bug this codebase keeps getting bitten by.
test('http client: unsupported options throw named errors, never silently ignored', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpopt-'));
  const f = path.join(dir, 'opts.cjs');
  fs.writeFileSync(f, `
const http = require('node:http');
const https = require('node:https');
const out = {};
const probe = (label, fn) => {
  try { fn(); out[label] = 'NO THROW'; }
  catch (e) { out[label] = { code: e.code, named: /node-shim:/.test(e.message) }; }
};
probe('socketPath', () => http.request({ socketPath: '/tmp/x', path: '/' }));
probe('createConnection', () => http.request({ host: 'h', createConnection: () => {}, path: '/' }));
probe('lookup', () => http.request({ host: 'h', lookup: () => {}, path: '/' }));
probe('localAddress', () => http.request({ host: 'h', localAddress: '10.0.0.1', path: '/' }));
probe('family', () => http.request({ host: 'h', family: 6, path: '/' }));
probe('pfx', () => https.request({ host: 'h', pfx: 'x', path: '/' }));
probe('ciphers', () => https.request({ host: 'h', ciphers: 'HIGH', path: '/' }));
probe('checkServerIdentity', () => https.request({ host: 'h', checkServerIdentity: () => {}, path: '/' }));
console.log(JSON.stringify(out));
`);
  try {
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    for (const [k, v] of Object.entries(got)) {
      assert.notStrictEqual(v, 'NO THROW', `option '${k}' was accepted and silently ignored`);
      assert.ok(v.named, `option '${k}' threw an unbranded error: ${JSON.stringify(v)}`);
    }
    assert.strictEqual(got.socketPath.code, 'ERR_SHIM_HTTP_UNSUPPORTED_OPTION');
    assert.strictEqual(got.createConnection.code, 'ERR_SHIM_HTTP_UNSUPPORTED_OPTION');
    assert.strictEqual(got.pfx.code, 'ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION');
    assert.strictEqual(got.checkServerIdentity.code, 'ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The one KNOWN divergence, recorded as a fact rather than left to surprise
// someone: this client never pools, so it always sends `Connection: close`,
// where node's default (pooling) agent sends `keep-alive`. Asserting BOTH sides
// here means the day the shim starts pooling, this test says so.
test('http client divergence: no pooling — Connection: close where node keep-alives', async (t) => {
  if (skipUnlessTjs(t)) return;
  const { proc, port } = await startOrigin('http-client-origin.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpka-'));
  const f = path.join(dir, 'ka.cjs');
  fs.writeFileSync(f, `
const http = require('node:http');
// The DEFAULT agent (pooling in node >= 19), not agent:false.
const r = http.request({ host: '127.0.0.1', port: ${port}, path: '/echo' }, (res) => {
  const c = []; res.on('data', (d) => c.push(d));
  res.on('end', () => {
    const sent = JSON.parse(Buffer.concat(c).toString()).headers.find((h) => /^connection:/i.test(h));
    console.log(JSON.stringify({ connection: sent }));
    process.exit(0);
  });
});
r.on('error', (e) => { console.error(e.message); process.exit(1); });
r.end();
`);
  try {
    const n = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(n.status, 0, n.stderr);
    assert.match(JSON.parse(n.stdout).connection, /keep-alive/i, 'node baseline: pooling agent keep-alives');
    const r = runLoader(f, [], { timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).connection, /close/i,
      'the shim client does not pool and must say so on the wire');
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

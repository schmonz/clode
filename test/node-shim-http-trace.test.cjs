'use strict';
// node:http/node:https CLIENT-request tracing (CLODE_SHIM_TRACE=1) — diagnostic
// for the live darwin-ppc/10.4 -p startup hang: a repeatable 6-row matrix
// isolated the trigger to the mere PRESENCE of ~/.claude/.credentials.json
// (hangs with the file, either key state; completes without it, both key
// states), and the hang happens BEFORE any API request. The existing fetch
// tracer (loader.cjs, CLODE_SHIM_TRACE) recorded exactly ONE request for the
// whole hung run — strong evidence the request that never settles is NOT
// going through globalThis.fetch. The bundle carries a token-refresh path
// (refresh_token, oauth/token) gated on credentials existing, and Node HTTP
// clients commonly go through node:http/node:https instead of fetch — which
// were a total blind spot: http.request/http.get were not implemented AT ALL
// (see http.cjs's prior header note), so there was no code there to trace.
// http.cjs now wires a minimal real client (backed by the same fetch
// transport already proven under tjs — see node-shim-http-server.test.cjs —
// so no new socket layer) with tracing built in. This locks three contracts:
//   1. enabled: a real request against a real local server logs a `[http] ->`
//      line and a matching completion line carrying the response status;
//   2. unset: the identical request logs nothing at all;
//   3. a connection-refused request (the case that matters most — an
//      unsettled request is exactly what a silent hang looks like) still
//      logs a TERMINAL `[http]` line, never leaving an unmatched `->`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

function writeProg(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
}

// Run the loader ASYNCHRONOUSLY (spawn, not spawnSync): the probe talks to a
// real http server running in THIS test process. spawnSync would block this
// process's own event loop for the child's whole lifetime, starving that
// server's accept/request handling — a self-deadlock in the test, not a shim
// bug. Mirrors test/node-shim-handle-dump.test.cjs's spawnLoader helper.
function runLoaderAsync(prog, env = {}) {
  const child = spawn(tjsPath(), ['run', LOADER, prog], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return { child, done, getOut: () => out, getErr: () => err };
}

// A hard ceiling so a genuine hang (the very failure mode under
// investigation) fails the test loudly instead of wedging the suite.
function withTimeout(child, promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`timed out waiting for ${what}`));
    }, ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const REQUEST_PROG = (port) => `
'use strict';
const http = require('node:http');
const req = http.request({ hostname: '127.0.0.1', port: ${port}, path: '/probe', method: 'GET' }, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => { console.log('DONE ' + res.statusCode + ' ' + data); process.exit(0); });
  res.on('error', (e) => { console.log('RES-ERR ' + String(e)); process.exit(1); });
});
req.on('error', (e) => { console.log('REQ-ERR ' + String(e)); process.exit(1); });
req.end();
`;

const REFUSED_PROG = (port) => `
'use strict';
const http = require('node:http');
const req = http.request({ hostname: '127.0.0.1', port: ${port}, path: '/nope', method: 'GET' }, (res) => {
  console.log('UNEXPECTED-RESPONSE ' + res.statusCode);
  process.exit(1);
});
req.on('error', (e) => { console.log('REQ-ERR ' + String((e && e.message) || e)); process.exit(0); });
req.end();
`;

test('http client trace: CLODE_SHIM_TRACE=1 logs a request and a matching completion line', async (t) => {
  if (skipUnlessTjs(t)) return;
  const server = await startServer();
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-http-trace-'));
  try {
    const prog = writeProg(dir, 'probe.cjs', REQUEST_PROG(port));
    const s = runLoaderAsync(prog, { CLODE_SHIM_TRACE: '1' });
    const r = await withTimeout(s.child, s.done, 15000, 'traced probe exit');
    assert.strictEqual(r.code, 0, `probe failed: out=${s.getOut()} err=${s.getErr()}`);
    assert.match(s.getOut(), /^DONE 200 ok/, `unexpected probe stdout: ${s.getOut()}`);
    const err = s.getErr();
    assert.match(err, /\[http\] ->.*GET.*\/probe/, `expected a [http] -> request line; err=${err}`);
    assert.match(err, /\[http\].*status=\s*200/, `expected a [http] completion line with status=200; err=${err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('http client trace: CLODE_SHIM_TRACE unset logs nothing', async (t) => {
  if (skipUnlessTjs(t)) return;
  const server = await startServer();
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-http-trace-off-'));
  try {
    const prog = writeProg(dir, 'probe.cjs', REQUEST_PROG(port));
    const env = { ...process.env };
    delete env.CLODE_SHIM_TRACE;
    const s = runLoaderAsync(prog, env);
    const r = await withTimeout(s.child, s.done, 15000, 'untraced probe exit');
    assert.strictEqual(r.code, 0, `probe failed: out=${s.getOut()} err=${s.getErr()}`);
    assert.match(s.getOut(), /^DONE 200 ok/, `unexpected probe stdout: ${s.getOut()}`);
    assert.strictEqual(s.getErr(), '', `expected silent stderr; err=${JSON.stringify(s.getErr())}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('http client trace: connection-refused still logs a terminal [http] line', async (t) => {
  if (skipUnlessTjs(t)) return;
  // Bind then immediately close a server to obtain a port nothing is
  // listening on — a real ECONNREFUSED, not a firewall/timeout black hole.
  const server = await startServer();
  const port = server.address().port;
  await new Promise((res) => server.close(res));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-http-trace-err-'));
  try {
    const prog = writeProg(dir, 'probe.cjs', REFUSED_PROG(port));
    const s = runLoaderAsync(prog, { CLODE_SHIM_TRACE: '1' });
    const r = await withTimeout(s.child, s.done, 15000, 'refused probe exit');
    assert.strictEqual(r.code, 0, `probe failed: out=${s.getOut()} err=${s.getErr()}`);
    assert.match(s.getOut(), /^REQ-ERR/, `expected the probe to observe a request error; out=${s.getOut()}`);
    const err = s.getErr();
    assert.match(err, /\[http\] ->.*GET.*\/nope/, `expected a [http] -> request line; err=${err}`);
    // Terminal line for the failed request, mirroring the fetch tracer's `xx`
    // convention for a request that did not succeed — never an unmatched `->`.
    assert.match(err, /\[http\] xx.*GET.*\/nope/, `expected a [http] xx terminal line; err=${err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

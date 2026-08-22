'use strict';
// node:http SERVER surface (Q1c): `clode build` runs its internal PONG smoke
// against an in-process http.createServer mock (libexec/clode-fuse.cjs
// startPongMock) — so the native clode builder needs a real, if minimal,
// http.Server under tjs. Characterized DIFFERENTIALLY: the same probe script
// (createServer -> fetch it -> echo shape) runs under host node (oracle) and
// under tjs via the node-shim loader; the JSON results must deep-equal.
// Surface covered = exactly what startPongMock uses: createServer(handler),
// listen(0, '127.0.0.1', cb), address().port, close(cb), req.method/url/
// headers + 'data'/'end' events, res.writeHead(status, headers), res.end(body).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROBE = `
'use strict';
const http = require('node:http');
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url });
    res.writeHead(201, { 'content-type': 'application/json', 'x-echo': req.headers['x-probe'] || '' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  });
});
server.listen(0, '127.0.0.1', async () => {
  try {
    const addr = server.address();
    const base = 'http://127.0.0.1:' + addr.port;
    const r1 = await fetch(base + '/v1/messages?beta=true', {
      method: 'POST', headers: { 'x-probe': 'p1' }, body: 'PING-BODY',
    });
    const echo1 = await r1.json();
    // A second sequential request proves the accept loop survives a served
    // connection (the agentic smoke makes multiple POSTs).
    const r2 = await fetch(base + '/second');
    const echo2 = await r2.json();
    console.log(JSON.stringify({
      addrShape: { isObject: typeof addr === 'object', portIsNum: typeof addr.port === 'number' },
      one: { status: r1.status, echoHeader: r1.headers.get('x-echo'), ctype: r1.headers.get('content-type'), echo: echo1 },
      two: { status: r2.status, echo: echo2 },
      requests,
    }));
    server.close(() => process.exit(0));
  } catch (e) {
    console.error('probe failed: ' + (e && e.stack || e));
    process.exit(1);
  }
});
`;

test('http server differential: createServer/listen/echo/close identical tjs vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpsrv-'));
  const probe = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probe, PROBE);
  try {
    const n = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(n.status, 0, `host node oracle failed:\n${n.stderr}`);
    const r = runLoader(probe, [], { timeout: 30000 });
    assert.strictEqual(r.status, 0, `tjs probe failed:\n${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(n.stdout.trim()),
      'server behavior diverged tjs vs node');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('http server: close(cb) fires and the port stops accepting', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpsrv2-'));
  const probe = path.join(dir, 'probe2.cjs');
  fs.writeFileSync(probe, `
'use strict';
const http = require('node:http');
const server = http.createServer((req, res) => { res.writeHead(200, {}); res.end('x'); });
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const r = await fetch('http://127.0.0.1:' + port + '/ok');
  await r.text();
  server.close(async () => {
    let refused = false;
    try { await fetch('http://127.0.0.1:' + port + '/gone'); }
    catch { refused = true; }
    console.log(JSON.stringify({ first: r.status, refused }));
    process.exit(0);
  });
});
`);
  try {
    const n = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(n.status, 0, `host node oracle failed:\n${n.stderr}`);
    const r = runLoader(probe, [], { timeout: 30000 });
    assert.strictEqual(r.status, 0, `tjs probe failed:\n${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(n.stdout.trim()));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { first: 200, refused: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Chunked REQUEST bodies used to be a loud wall here ("node-shim: http.Server
// chunked request bodies not implemented"). They work now, not because the
// server grew a special case but because the server and the new client share
// ONE message parser (libexec/node-shim/modules/http.cjs, "shared message
// parsing") — the client had to decode chunked anyway, and a second copy is how
// the two faces would have drifted. Differential, like every row above: the
// same probe runs under host node and under tjs.
test('http server: chunked request bodies decode identically tjs vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-httpchunk-'));
  const probe = path.join(dir, 'chunk.cjs');
  fs.writeFileSync(probe, `
'use strict';
const http = require('node:http');
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(JSON.stringify({
      te: req.headers['transfer-encoding'] || null,
      cl: req.headers['content-length'] || null,
      body: Buffer.concat(chunks).toString('utf8'),
      complete: req.complete,
    }));
  });
});
server.listen(0, '127.0.0.1', () => {
  // write()+write()+end() with no Content-Length => the client frames it as
  // Transfer-Encoding: chunked, which the server then has to decode.
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/chunked-in', method: 'POST', agent: false }, (res) => {
    const out = [];
    res.on('data', (c) => out.push(c));
    res.on('end', () => {
      console.log(Buffer.concat(out).toString());
      server.close(() => process.exit(0));
    });
  });
  req.on('error', (e) => { console.error(e.stack || e); process.exit(1); });
  req.write('alpha-');
  req.write('beta-');
  req.end('gamma');
});
`);
  try {
    const n = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(n.status, 0, `host node oracle failed:\n${n.stderr}`);
    const r = runLoader(probe, [], { timeout: 30000 });
    assert.strictEqual(r.status, 0, `tjs probe failed:\n${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(n.stdout.trim()),
      'chunked request-body handling diverged tjs vs node');
    assert.strictEqual(JSON.parse(n.stdout.trim()).te, 'chunked', 'the probe must actually exercise chunked framing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
// fetch() input forms — found 2026-08-06 by driving an MCP server over HTTP.
//
// The engine's fetch derived its URL as:
//     const rawUrl = typeof input === 'string' ? input : input?.url;
// A URL object has .href, NOT .url, so `fetch(new URL(...))` produced
// rawUrl === undefined and died inside `new URL(undefined)` as
// "TypeError: Invalid URL". node accepts a string, a URL, or a Request.
//
// It broke MCP over HTTP outright: the SDK's Streamable-HTTP transport builds a
// URL object for its endpoint, so every request failed BEFORE a socket was
// opened. The server logged nothing at all and the client reported the server as
// "still connecting" forever — the same silent shape as the stdio transport bug
// (missing 'spawn'), reached by a completely different route.
//
// Hermetic: a local one-shot HTTP server, no network and no API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// A child-process HTTP server, polled synchronously. An in-process async server
// deadlocked node:test here (the run produced no output at all), and these tests
// drive a spawnSync'd child anyway — so the whole file stays synchronous, which
// is also how the rest of this suite is written.
const { spawnSync, spawn } = require('node:child_process');

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchinput-srv-'));
  const urlFile = path.join(dir, 'url');
  const js = path.join(dir, 'srv.js');
  fs.writeFileSync(js, `
    const http = require('node:http'), fs = require('node:fs');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
    });
    srv.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(process.argv[2], 'http://127.0.0.1:' + srv.address().port + '/mcp');
    });
  `);
  const child = spawn(process.execPath, [js, urlFile], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(urlFile)) {
      const url = fs.readFileSync(urlFile, 'utf8').trim();
      if (url) return { url, stop() { try { child.kill('SIGKILL'); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); } };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

function prog(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fetchinput-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    const target = ${JSON.stringify(url)};
    (async () => {
      const out = {};
      // A string has always worked; the URL form is the regression.
      for (const [label, input] of [['string', target], ['urlObject', new URL(target)]]) {
        try {
          const r = await fetch(input, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
          out[label] = 'status:' + r.status;
        } catch (e) { out[label] = 'THREW:' + e.name + ':' + e.message; }
      }
      console.log(JSON.stringify(out));
    })();
  `);
  return f;
}

test('fetch accepts a URL object, not just a string (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const srv = startServer();
  if (!srv) { t.skip('could not start the local HTTP server'); return; }
  try {
    const f = prog(srv.url);
    const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
    // Pre-fix: {string:'status:200', urlObject:'THREW:TypeError:Invalid URL'}.
    assert.strictEqual(node.string, 'status:200');
    assert.strictEqual(node.urlObject, 'status:200');
  } finally { srv.stop(); }
});

// Guard the DOCUMENTED remaining gap so it stays visible rather than forgotten.
// node also accepts a Request with a body; the engine rejects it with
// 'ReadableStream body requires duplex: "half"'. No bundle-reachable caller has
// been observed (the MCP transports pass a URL + init), so it is recorded, not
// faked. Delete this row the day it is implemented.
test('KNOWN GAP: fetch(Request with a body) still rejects (node accepts it)', (t) => {
  if (skipUnlessTjs(t)) return;
  const srv = startServer();
  if (!srv) { t.skip('could not start the local HTTP server'); return; }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fetchreq-'));
    const f = path.join(dir, 'p.cjs');
    fs.writeFileSync(f, `
      (async () => {
        try {
          const r = await fetch(new Request(${JSON.stringify(srv.url)}, { method: 'POST', body: '{}' }));
          console.log(JSON.stringify({ result: 'status:' + r.status }));
        } catch (e) { console.log(JSON.stringify({ result: 'THREW:' + e.message })); }
      })();
    `);
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout.trim()).result, /THREW:.*duplex/,
      'if this now succeeds, the gap is closed — delete this test and note it in the commit');
  } finally { srv.stop(); }
});

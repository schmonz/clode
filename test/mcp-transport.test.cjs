'use strict';
// The MCP transports, measured — because every one of them was broken silently.
//
// Three of the four were found broken this week, each by a different route, and
// each ONLY because a human happened to drive it:
//
//   stdio  the shim never emitted ChildProcess 'spawn'        (fixed 2383de2)
//   http   fetch(URL object) died before opening a socket     (fixed fc54ae9)
//   sse    MessageEvent put the whole init dict in .data, so
//          every JSON-RPC POST went to /[object Object]       (fixed 97f12ea)
//   ws     never driven at all
//
// None of them threw anything a test would have noticed; the failures were wrong
// SHAPES, not missing functions. So this file exists to make "does transport X
// work?" a thing CI answers rather than a thing someone remembers to ask.
//
// The mock servers live in test/fixtures/mcp/ and are dependency-free on purpose:
// `ws` is not installed here, and depending on it would make the measurement
// depend on the thing being measured. They record what actually ARRIVED
// (MCP_MOCK_WIRE), so assertions are about the wire, not about what a client
// claims it sent — the SSE bug was invisible from the client side.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const FIXTURES = path.join(REPO, 'test/fixtures/mcp');

// Start a mock, wait for it to publish its port. Synchronous polling, matching
// the rest of this suite (an in-process async server has deadlocked node:test
// here before).
function startMock(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mock-'));
  const portFile = path.join(dir, 'port');
  const wire = path.join(dir, 'wire');
  fs.writeFileSync(wire, '');
  const child = spawn(process.execPath, [path.join(FIXTURES, script), portFile], {
    stdio: 'ignore',
    env: { ...process.env, MCP_MOCK_WIRE: wire },
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const p = fs.readFileSync(portFile, 'utf8').trim();
      if (p) {
        return {
          port: Number(p),
          wire: () => fs.readFileSync(wire, 'utf8'),
          stop() {
            try { child.kill('SIGKILL'); } catch { /* */ }
            fs.rmSync(dir, { recursive: true, force: true });
          },
        };
      }
    } catch { /* not yet */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try { child.kill('SIGKILL'); } catch { /* */ }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

function waitForWire(mock, re, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (re.test(mock.wire())) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return false;
}

// ---------------------------------------------------------------------------
// SSE: the root cause, pinned at the layer it actually broke.
//
// The bug was NOT in SSE parsing or URL resolution — both were proven identical
// to node before it was found. It was MessageEvent: `new MessageEvent(type, init)`
// takes an init DICTIONARY and .data is init.data, but the polyfill stored the
// whole dictionary, so the bundle's `new URL(event.data, base)` stringified an
// object. Pinning the constructor's semantics catches it at the source, and does
// so in milliseconds without needing a built quaude.
test('MessageEvent takes an init dict, like node (the MCP-over-SSE root cause)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-msgevt-'));
  const f = path.join(dir, 'me.cjs');
  fs.writeFileSync(f, `
    const full = new MessageEvent('m', { data: '/messages?sessionId=probe', origin: 'http://h', lastEventId: '7' });
    const bare = new MessageEvent('m');
    const out = (e) => ({ data: e.data, origin: e.origin, lastEventId: e.lastEventId, ports: e.ports, source: e.source });
    console.log(JSON.stringify({ full: out(full), bare: out(bare) }));
  `);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
  // Regression guard in the bug's own terms: .data must be the STRING, never the
  // dictionary. Pre-fix this was {data,origin,lastEventId} and resolved to
  // http://h/[object Object].
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(typeof got.full.data, 'string');
  assert.strictEqual(new URL(got.full.data, 'http://h').pathname, '/messages');
});

// ---------------------------------------------------------------------------
// WebSocket: drive a real connection against a real RFC6455 server and assert on
// what ARRIVED. The existing ws oracle proves an echo round-trips; this asserts
// the request line, which an echo test cannot see because servers tolerate it.
test('WebSocket connects to a real RFC6455 server and sends a well-formed request line', (t) => {
  if (skipUnlessTjs(t)) return;
  const mock = startMock('ws-server.cjs');
  if (!mock) { t.skip('could not start the ws mock'); return; }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ws-'));
    const f = path.join(dir, 'ws.cjs');
    fs.writeFileSync(f, `
      const ws = new WebSocket('ws://127.0.0.1:${mock.port}/');
      ws.onopen = () => { try { ws.close(); } catch {} };
      setTimeout(() => {}, 1500);
    `);
    runLoader(f, [], { timeout: 15000 });
    assert.ok(waitForWire(mock, /UPGRADE /), `no upgrade reached the server. wire:\n${mock.wire()}`);

    const observed = (mock.wire().match(/UPGRADE (\S+)/) || [])[1];
    // The request line must be what node sends, not merely something servers
    // tolerate. This began life as a recorded gap — the engine asked for "//" on
    // a root URL, because lws_parse_uri strips the slash for "mcp" but yields "/"
    // for ws://host/, and ws.c prepended unconditionally. Most servers route "//"
    // happily, which is why the echo oracle never saw it. Fixed in
    // txiki-ws-root-path.patch, so this now asserts equality instead of tolerance.
    assert.strictEqual(observed, '/', 'root-URL WebSocket must request "/" exactly, as node does');
  } finally { mock.stop(); }
});

// ---------------------------------------------------------------------------
// WebSocket PARITY on the surface the bundle actually uses.
//
// quaude and naude do not share a WebSocket: naude and Claude get npm `ws`, while
// under tjs require('ws') fails and bun-shim falls back to the engine's native
// WHATWG WebSocket. So divergence is the default, and the bundle consumes the
// object BOTH ways — WHATWG (`new WebSocket(url,{headers})` + addEventListener)
// and ws-shaped (`removeAllListeners()`, `readyState === OPEN ? close() :
// terminate()`). The native WS had none of on/once/removeAllListeners/terminate,
// so the second path died with "not a function" — while __clodeWsUnavailable
// reported the transport as AVAILABLE.
//
// bun-shim now dresses the native socket in that surface. This row drives the
// exact ws-shaped sequence and pins the result. The expected value was not
// invented: it was established differentially on 2026-08-21 against npm ws on
// real node, which produced the identical array.
test('WebSocket: a ws-shaped consumer sees the same sequence as npm ws', (t) => {
  if (skipUnlessTjs(t)) return;
  const mock = startMock('ws-server.cjs');
  if (!mock) { t.skip('could not start the ws mock'); return; }
  try {
    const r = runLoader(path.join(FIXTURES, 'ws-style-client.cjs'), [], {
      timeout: 20000,
      env: {
        CLODE_BUN_SHIM: path.join(REPO, 'libexec/bun-shim.cjs'),
        WS_URL: `ws://127.0.0.1:${mock.port}/`,
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse((r.stdout || '').trim().split('\n')[0] || '[]');
    assert.deepStrictEqual(got, [
      'open',
      'message:{"jsonrpc":"2.0","id":1,:isBinary=false',
      'close:1000',
    ], 'ws-shaped surface diverged from npm ws');
    // The client-visible sequence matching was never enough, and this row is the
    // reason to keep saying so: for a while the engine passed the assertion above
    // while sending NO close frame at all. It dropped the TCP connection and
    // synthesized the close event locally from the code close() was handed, so
    // ["open","message:…","close:1000"] came out identical either way — the
    // divergence was only ever visible on the WIRE, where npm ws logged
    // "UPGRADE /" then "CLOSE" and the engine logged "UPGRADE /" and nothing else.
    //
    // Fixed in the engine (spike/quickjs/patches/txiki-ws-close-frame.patch): close()
    // now runs the RFC6455 closing handshake, so opcode 0x8 reaches the peer with
    // code 1000 and reason "done" and lws waits for the peer's ack. Both halves are
    // asserted together on purpose — the wire proves the frame went out, the sequence
    // proves the handshake did not change what the consumer sees.
    assert.match(mock.wire(), /CLOSE/,
      `close() sent no RFC6455 close frame — the peer saw a dropped connection. wire:\n${mock.wire()}`);
  } finally { mock.stop(); }
});

// ---------------------------------------------------------------------------
// The mocks themselves must be trustworthy, or every row above is decoration.
// A mock that silently fails to record would make the SSE assertion vacuous.
test('the MCP mocks record what arrived (the instrument is not decoration)', () => {
  const mock = startMock('sse-server.cjs');
  assert.ok(mock, 'sse mock did not start');
  try {
    execFileSync(process.execPath, ['-e', `
      const http = require('node:http');
      const req = http.request({ host: '127.0.0.1', port: ${mock.port}, path: '/messages?sessionId=probe', method: 'POST' },
        (res) => res.resume());
      req.end('{}');
    `], { encoding: 'utf8' });
    assert.ok(waitForWire(mock, /POST \/messages\?sessionId=probe/),
      `the mock did not record a request it certainly received. wire:\n${mock.wire()}`);
  } finally { mock.stop(); }
});

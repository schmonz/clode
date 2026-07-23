// test/websocket.test.cjs — Bun-style WebSocket adapter over the npm `ws` dep,
// and the FAIL-FAST-AND-LOUD behavior when `ws` isn't installed.
//
// `ws` is the first of the "external dependency, required at startup" pattern:
// the bundle require()s it inside a render-gating startup promise, which SWALLOWS
// any thrown error -> the interactive TUI hangs with a blank screen. So a missing
// ext-dep must be UNSWALLOWABLE: announce on stderr AND exit non-zero, even when
// the caller wraps the use in try/catch. (A plain `throw` is not enough — it gets
// eaten by the bundle's promise and the user sees nothing.)
const { test } = require('node:test');
const assert = require('node:assert');
const shim = require('../libexec/bun-shim.cjs');
const { _wsArgs } = shim;
// runShimChild loads the shim from a temp copy OUTSIDE the repo with cwd there, so
// the child can never resolve a globally- OR repo-installed `ws` (even the child's
// own require('ws') walks a clean chain) — these tests assert the ws-ABSENT
// behavior deterministically regardless of the repo's node_modules.
const { runShimChild } = require('./isolated-shim.cjs');

test('_wsArgs: Bun single-options object -> ws (url, protocols, {headers})', () => {
  assert.deepStrictEqual(
    _wsArgs('wss://x/y', { protocols: ['mcp'], headers: { authorization: 'Bearer t' } }),
    ['wss://x/y', ['mcp'], { headers: { authorization: 'Bearer t' } }]);
});

test('_wsArgs: Bun tls options fold into ws options (ca/cert/rejectUnauthorized)', () => {
  assert.deepStrictEqual(
    _wsArgs('wss://x', { headers: { a: '1' }, tls: { rejectUnauthorized: false } }),
    ['wss://x', undefined, { headers: { a: '1' }, rejectUnauthorized: false }]);
});

test('_wsArgs: WHATWG protocols form (2nd arg is protocols, not options)', () => {
  assert.deepStrictEqual(_wsArgs('wss://x', ['mcp']), ['wss://x', ['mcp'], undefined]);
  assert.deepStrictEqual(_wsArgs('wss://x'), ['wss://x', undefined, undefined]);
});

test('globalThis.WebSocket is the adapter and exposes the ready-state constants', () => {
  assert.strictEqual(typeof globalThis.WebSocket, 'function');
  assert.strictEqual(globalThis.WebSocket.OPEN, 1);
  assert.strictEqual(globalThis.WebSocket.CONNECTING, 0);
});

test('fail-loud: missing ws cannot be swallowed — require("ws") prints to stderr and exits', () => {
  // Mimics the bundle's render-gating require: the caller swallows the failure.
  // It must STILL surface (stderr) and STILL stop the process (no CONTINUED).
  const r = runShimChild(`try { require('ws'); } catch (_) {} console.log('CONTINUED');`);
  assert.notStrictEqual(r.status, 0, 'must exit non-zero when ws is missing');
  assert.doesNotMatch(r.stdout, /CONTINUED/, 'must not continue past a swallowed failure');
  assert.match(r.stderr, /ws/);
  assert.match(r.stderr, /npm install/);
});

test('fail-loud: missing ws cannot be swallowed — new WebSocket prints to stderr and exits', () => {
  const r = runShimChild(
    `try { new globalThis.WebSocket('wss://x', { headers: { a: '1' } }); } catch (_) {} console.log('CONTINUED');`);
  assert.notStrictEqual(r.status, 0, 'must exit non-zero when ws is missing');
  assert.doesNotMatch(r.stdout, /CONTINUED/, 'must not continue past a swallowed failure');
  assert.match(r.stderr, /ws/);
});

test('__clodeWsUnavailable is true in an isolated shim child (no ws)', () => {
  const r = runShimChild(`console.log('WSFLAG=' + globalThis.__clodeWsUnavailable);`);
  assert.strictEqual(r.status, 0, 'reading the flag must not exit the process');
  assert.match(r.stdout, /WSFLAG=true/);
});

test('under tjs with no npm ws, BunWebSocket delegates to the native WS with {headers, protocols} and flips the flag', () => {
  const preamble = `
    globalThis.tjs = globalThis.tjs || {};                 // make UNDER_TJS true
    globalThis.__captured = null;
    globalThis.WebSocket = function FakeNative(url, opts){ globalThis.__captured = { url, opts }; };
  `;
  const body = `
    // the shim has now overridden globalThis.WebSocket with BunWebSocket, capturing FakeNative
    new globalThis.WebSocket('wss://bridge.example', { protocols: ['mcp'], headers: { Authorization: 'Bearer T' } });
    const c = globalThis.__captured;
    const ok = !!(c && c.url === 'wss://bridge.example'
      && c.opts && c.opts.headers && c.opts.headers.Authorization === 'Bearer T'
      && Array.isArray(c.opts.protocols) && c.opts.protocols[0] === 'mcp');
    console.log('DELEGATED=' + ok);
    console.log('FLAG=' + globalThis.__clodeWsUnavailable);
  `;
  const r = runShimChild(body, {}, preamble);
  assert.match(r.stdout, /DELEGATED=true/, r.stdout + r.stderr);
  assert.match(r.stdout, /FLAG=false/, r.stdout + r.stderr);
});

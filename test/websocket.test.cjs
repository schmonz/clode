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
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const shim = require('../libexec/bun-shim.cjs');
const { _wsArgs } = shim;

const SHIM = path.resolve(__dirname, '../libexec/bun-shim.cjs');
// Run a child node that loads the shim, then runs `body`. NODE_PATH is cleared so
// the child can never resolve a globally-installed `ws` — these tests assert the
// ws-ABSENT behavior deterministically on any machine.
function runChild(body) {
  return spawnSync(process.execPath,
    ['-e', `require(${JSON.stringify(SHIM)});\n${body}`],
    { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
}

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
  const r = runChild(`try { require('ws'); } catch (_) {} console.log('CONTINUED');`);
  assert.notStrictEqual(r.status, 0, 'must exit non-zero when ws is missing');
  assert.doesNotMatch(r.stdout, /CONTINUED/, 'must not continue past a swallowed failure');
  assert.match(r.stderr, /ws/);
  assert.match(r.stderr, /npm install/);
});

test('fail-loud: missing ws cannot be swallowed — new WebSocket prints to stderr and exits', () => {
  const r = runChild(
    `try { new globalThis.WebSocket('wss://x', { headers: { a: '1' } }); } catch (_) {} console.log('CONTINUED');`);
  assert.notStrictEqual(r.status, 0, 'must exit non-zero when ws is missing');
  assert.doesNotMatch(r.stdout, /CONTINUED/, 'must not continue past a swallowed failure');
  assert.match(r.stderr, /ws/);
});

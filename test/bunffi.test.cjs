// Standalone test: requiring bun-shim installs a resolver so that
// require('bun:ffi') returns the shim (instead of "Cannot find module"),
// and its dlopen throws so the cli's try/catch fallbacks engage.
const { test } = require('node:test');
const assert = require('node:assert');
require('../libexec/bun-shim.cjs');

test('bun:ffi resolves to shim and dlopen throws', () => {
  const ffi = require('bun:ffi');           // must resolve to the shim, not throw
  assert.strictEqual(typeof ffi.dlopen, 'function', 'no dlopen');

  let threw = false;
  try { ffi.dlopen('/x', {}); } catch (_) { threw = true; }
  assert.ok(threw, 'dlopen should throw (fallback path)');
});

test('globalThis.Bun is installed as side effect of requiring shim', () => {
  assert.strictEqual(typeof globalThis.Bun, 'object', 'globalThis.Bun not installed');
  assert.strictEqual(typeof globalThis.Bun.stringWidth, 'function', 'Bun.stringWidth missing');
});

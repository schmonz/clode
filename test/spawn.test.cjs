// Bun.spawn on a MISSING executable must not hang. Bun resolves the binary
// synchronously and throws if absent; Node's cp.spawn emits 'error' (never
// 'exit') async. A shim that builds `exited` only from 'exit' makes
// `await proc.exited` hang forever — which froze the interactive TUI when it
// spawned `rg` (ripgrep) and that wasn't on PATH.
// Pass = Bun.spawn either throws synchronously OR proc.exited resolves quickly.
const { test } = require('node:test');
const assert = require('node:assert');
globalThis.Bun = require('../libexec/bun-shim.cjs');

test('Bun.spawn on missing binary throws or resolves exited quickly (no hang)', async () => {
  const MISSING = 'definitely-not-a-real-binary-xyz123';
  let proc = null, threwSync = false;
  try { proc = Bun.spawn([MISSING]); }
  catch (_) { threwSync = true; }

  if (threwSync) { return; }  // OK: threw synchronously, Bun-like

  assert.ok(proc && proc.exited, 'neither threw nor returned a usable proc');

  const hang = new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 3000));
  const code = await Promise.race([proc.exited, hang]);
  assert.notStrictEqual(code, 0, 'missing binary reported success');
});

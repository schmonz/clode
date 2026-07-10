'use strict';
// Q1b item 6: the reserved --quaude-* argv namespace. The carve runs in the
// quaude bootstrap BEFORE any bundle-visible code, so these are pure unit
// tests of carveQuaudeArgs (libexec/quaude-bootstrap.mjs exports it and gates
// its tjs-only main() on globalThis.tjs, so host node can import it). The
// end-to-end behavior (--quaude-attest short-circuits, unknown --quaude-foo
// errors from quaude without reaching the bundle) is covered against a real
// fused binary in test/quaude-build.test.cjs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BOOTSTRAP = path.resolve(__dirname, '../libexec/quaude-bootstrap.mjs');
const load = () => import(BOOTSTRAP);

test('carve: --quaude-attest is stripped into the quaude bucket, rest untouched in order', async () => {
  const { carveQuaudeArgs } = await load();
  const r = carveQuaudeArgs(['-p', 'say PONG', '--quaude-attest', '--allowedTools', 'Bash']);
  assert.deepStrictEqual(r.quaude, ['--quaude-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'say PONG', '--allowedTools', 'Bash']);
  assert.deepStrictEqual(r.unknown, []);
});

test('carve: any position works, including first', async () => {
  const { carveQuaudeArgs } = await load();
  const r = carveQuaudeArgs(['--quaude-attest', '-p', 'x']);
  assert.deepStrictEqual(r.quaude, ['--quaude-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'x']);
});

test('carve: unknown --quaude-* flags land in unknown (reserved namespace, never the bundle)', async () => {
  const { carveQuaudeArgs } = await load();
  const r = carveQuaudeArgs(['--quaude-frobnicate', '-p', 'x', '--quaude-attest']);
  assert.deepStrictEqual(r.unknown, ['--quaude-frobnicate']);
  assert.deepStrictEqual(r.quaude, ['--quaude-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'x']);
});

test('carve: only the exact --quaude- PREFIX is reserved; lookalikes pass through', async () => {
  const { carveQuaudeArgs } = await load();
  const r = carveQuaudeArgs(['--quaude', 'explain --quaude-attest to me', '-quaude-attest']);
  assert.deepStrictEqual(r.quaude, []);
  assert.deepStrictEqual(r.unknown, []);
  // A PROMPT merely containing the flag text is one argv element not starting
  // with the prefix — it must reach the bundle verbatim.
  assert.deepStrictEqual(r.rest, ['--quaude', 'explain --quaude-attest to me', '-quaude-attest']);
});

test('carve: empty argv yields three empty buckets', async () => {
  const { carveQuaudeArgs } = await load();
  assert.deepStrictEqual(carveQuaudeArgs([]), { quaude: [], rest: [], unknown: [] });
});

test('QUAUDE_FLAGS is the single source of truth for the known set', async () => {
  const { carveQuaudeArgs, QUAUDE_FLAGS } = await load();
  assert.ok(QUAUDE_FLAGS.includes('--quaude-attest'));
  for (const f of QUAUDE_FLAGS) {
    const r = carveQuaudeArgs([f]);
    assert.deepStrictEqual(r.quaude, [f], `${f} must carve as known`);
    assert.deepStrictEqual(r.unknown, []);
  }
});

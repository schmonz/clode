'use strict';
// The instrument that every phase-3 differential stands on. It runs a JS program INSIDE
// native Claude's own Bun (BUN_OPTIONS=--preload). Its failure mode is the dangerous one:
// a preload that silently did not run looks exactly like "native had nothing to say". So
// these tests prove it REFUSES in each of those cases, and that it can tell a planted
// wrong answer from a right one when native is present.
const test = require('node:test');
const assert = require('node:assert');
const { resolveNativeClaude, resolveNativeOracle, nativeVersion, runInNative } =
  require('../scripts/lib/native-oracle.cjs');

test('refuses a binary that does not exist', () => {
  assert.throws(() => runInNative('/no/such/claude', 'return 1;'),
    (e) => e.name === 'NativeOracleRefusal' && /does not exist/.test(e.message));
});

test('refuses when the preload silently did not run (a binary that ignores BUN_OPTIONS)', () => {
  // node honours no BUN_OPTIONS, exits 0 from --version, and writes nothing: exactly the
  // shape of a future native build that dropped the preload hook.
  assert.throws(() => runInNative(process.execPath, 'return 1;'),
    (e) => e.name === 'NativeOracleRefusal' && /preload did not run/.test(e.message));
});

// R1 (controller ruling, phase-3 task 1): resolveNativeOracle() and resolveNativeClaude()
// read DIFFERENT env vars on purpose — the oracle answers "what does native say" (any
// build with the feature under test), the claude resolver answers "what is the SAME-VERSION
// reference" (the frame gate's job). Prove they actually differ, not just that both exist.
test('resolveNativeOracle and resolveNativeClaude read different env vars', () => {
  const oraclePath = process.execPath; // guaranteed to exist; never a real `claude`
  const claudePath = __filename; // a second, different, guaranteed-to-exist path
  const env = { CLODE_NATIVE_ORACLE: oraclePath, CLODE_NATIVE_CLAUDE: claudePath };
  assert.strictEqual(resolveNativeOracle(env), oraclePath,
    'CLODE_NATIVE_ORACLE must win for the oracle resolver');
  assert.strictEqual(resolveNativeClaude(env), claudePath,
    'resolveNativeClaude must never consult CLODE_NATIVE_ORACLE');

  const missingOracleEnv = { CLODE_NATIVE_ORACLE: '/no/such/oracle', CLODE_NATIVE_CLAUDE: claudePath };
  assert.strictEqual(resolveNativeOracle(missingOracleEnv), null,
    'a CLODE_NATIVE_ORACLE naming a missing path must return null, not fall back to resolveNativeClaude');
});

const NATIVE = resolveNativeOracle();
const skipNoNative = NATIVE ? false : 'no native claude (set CLODE_NATIVE_ORACLE or CLODE_NATIVE_CLAUDE, or put `claude` on PATH)';

test('runs a program inside native Bun and returns its value', { skip: skipNoNative }, () => {
  const v = runInNative(NATIVE, 'return { bun: typeof Bun.version, sum: input.a + input.b };', { input: { a: 2, b: 3 } });
  assert.deepStrictEqual(v, { bun: 'string', sum: 5 });
});

test('refuses when the program itself throws', { skip: skipNoNative }, () => {
  assert.throws(() => runInNative(NATIVE, 'throw new Error("planted");'),
    (e) => e.name === 'NativeOracleRefusal' && /planted/.test(e.message));
});

test('a planted wrong answer is distinguishable from native\'s', { skip: skipNoNative }, () => {
  const native = runInNative(NATIVE, 'return Bun.stringWidth(input);', { input: '中' });
  assert.strictEqual(native, 2, 'native says CJK is 2 columns');
  assert.notStrictEqual(1, native, 'a width-1 implementation would be caught');
});

test('nativeVersion names the Claude version', { skip: skipNoNative }, () => {
  assert.match(nativeVersion(NATIVE), /^\d+\.\d+\.\d+/);
});

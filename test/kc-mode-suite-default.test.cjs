'use strict';
// Regression guard for the fix in test/run.mjs: the suite must default
// CLODE_KC_MODE so libexec/node-shim/modules/child_process.cjs's `_kcDetect()`
// never probes the operator's REAL macOS login Keychain via the real `security`
// binary during `node test/run.mjs`. The bug this guards: node-shim-roundtrip
// .test.cjs and node-shim-roundtrip-oracle.test.cjs spawn tjs with an env that
// inherits process.env (`{...process.env, HOME: freshHome, ...}`) but never
// pinned CLODE_KC_MODE, so with no default `_kcMaybe` fell through to
// `_kcProbe()`, popping "Could not find a keychain to store
// '__clode_kc_probe__'" (and more, naming the operator's real account) modal
// dialogs — proved live via CLODE_SHIM_TRACE against a decoy PATH (see the
// task-10 report) before this fix landed.
//
// Two layers, same shape as node-shim-helper.cjs's wantsTrampoline split:
//  1. Unit-tests the pure decision fn directly (guards the LOGIC).
//  2. Asserts the ambient ...process.env this test itself inherited actually
//     carries CLODE_KC_MODE (guards the WIRING — that test/run.mjs really
//     calls the fn before spawning `node --test`). That assertion is only
//     guaranteed true when invoked THROUGH test/run.mjs (or with the var
//     exported by hand first) — same as every other guarantee test/run.mjs's
//     top-level setup provides (CLODE_NODE, the hermeticity guard, etc.); it
//     is not meant to hold for an arbitrary standalone `node --test` of just
//     this file.
const test = require('node:test');
const assert = require('node:assert');
const { defaultKcMode } = require('../scripts/kc-mode.cjs');

test('defaultKcMode: no ambient CLODE_KC_MODE -> pins "emulate" (never the real probe)', () => {
  assert.strictEqual(defaultKcMode({}), 'emulate');
});

test('defaultKcMode: an operator override is preserved untouched', () => {
  assert.strictEqual(defaultKcMode({ CLODE_KC_MODE: 'passthrough' }), 'passthrough');
  assert.strictEqual(defaultKcMode({ CLODE_KC_MODE: 'translate' }), 'translate');
  assert.strictEqual(defaultKcMode({ CLODE_KC_MODE: '' }), ''); // explicit empty string is still "set"
});

test('suite wiring: this test\'s own env carries a pinned CLODE_KC_MODE (set by test/run.mjs)', () => {
  assert.notStrictEqual(process.env.CLODE_KC_MODE, undefined,
    'CLODE_KC_MODE is unset — either this file was run standalone outside test/run.mjs ' +
    '(export CLODE_KC_MODE=emulate first), or test/run.mjs stopped defaulting it, which ' +
    'means the suite can pop real macOS Keychain dialogs again');
});

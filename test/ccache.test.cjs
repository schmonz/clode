'use strict';
// scripts/ccache-launcher.cjs — spec 4c3 task 1 ("wire it, optionally"). The property
// that matters most is the NEGATIVE one: a leg that has never heard of the tool must
// build EXACTLY as it did before this file existed. This box is such a leg (verified
// below, not assumed), so the absent-path assertion here is real, not simulated.
//
// This file imports the module under test directly rather than reading
// scripts/build-tjs.cjs as text — that file runs a real engine build top to bottom the
// moment it is required, so nothing here can afford to require() it. The two exported
// functions are the entire seam scripts/build-tjs.cjs uses; testing them by direct call
// is testing the real behavior, not a reimplementation of it.
const { test } = require('node:test');
const assert = require('node:assert');
const { ccacheLauncher, applyCcacheArg } = require('../scripts/ccache-launcher.cjs');
const { findTool } = require('../libexec/clode-hosttools.cjs');

// A fixed base array, standing in for whatever scripts/build-tjs.cjs's own cmakeArgs
// looked like the moment before this feature's one call site was added. Every "byte-
// identical" assertion below compares against a fresh copy of this same array.
const BASE_ARGS = Object.freeze(['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF']);

// ---- the absent path, proven on THIS box's real state, not a mock -----------------

test('this box genuinely has no ccache on PATH (so the next test is real, not simulated)', () => {
  assert.strictEqual(findTool('ccache'), null,
    'this test only means what it says if ccache is actually missing here — if this ever '
    + 'starts failing because someone installed it, the absent-path test below needs a '
    + 'PATH override instead of relying on ambient state');
});

test('absent: cmakeArgs comes out byte-identical to before this feature existed', () => {
  const path = ccacheLauncher({ env: {}, findToolFn: findTool });
  assert.strictEqual(path, null, 'the real findTool must report ccache absent on this box');
  const out = applyCcacheArg([...BASE_ARGS], path);
  assert.deepStrictEqual(out, BASE_ARGS,
    'a leg with no ccache must see the exact same cmakeArgs it saw before this feature '
    + 'shipped — no new entry, no reordering');
});

test('opt-out: CLODE_TJS_CCACHE=0 suppresses the probe even when a launcher would resolve', () => {
  const fakeFindToolFn = () => '/fake/bin/ccache';
  const path = ccacheLauncher({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, null, 'the opt-out must win over a resolvable launcher');
  assert.deepStrictEqual(applyCcacheArg([...BASE_ARGS], path), BASE_ARGS);
});

// ---- the present path, exercised through the injection seam, not a real install ----
//
// WHAT THIS PROVES: given a launcher path, the flag lands, with the right value, exactly
// once. WHAT THIS DOES NOT PROVE: that a REAL ccache binary at that path behaves as a
// correct cmake compiler launcher, or that its cache is keyed safely across a cross leg
// or the tjsc regen path — that is task 2's job, against a real install. This only
// proves scripts/build-tjs.cjs's OWN detect-and-push wiring is correct once something is
// found; the finding itself is faked here on purpose, since this box has nothing to find.

test('present: an injected launcher lands as -DCMAKE_C_COMPILER_LAUNCHER exactly once', () => {
  const fakeFindToolFn = (name) => (name === 'ccache' ? '/fake/bin/ccache' : null);
  const path = ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, '/fake/bin/ccache');
  const out = applyCcacheArg([...BASE_ARGS], path);
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.strictEqual(hits.length, 1, `expected exactly one launcher flag, got: ${out.join(' ')}`);
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache']);
});

test('the injection seam is really being used: a name other than ccache resolves to nothing', () => {
  const fakeFindToolFn = (name) => (name === 'some-other-tool' ? '/fake/bin/other' : null);
  assert.strictEqual(ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn }), null,
    'ccacheLauncher must ask findToolFn for "ccache" specifically, not accept anything found');
});

// ---- red proofs: each assertion above actually catches the broken version it exists ----
// ---- to catch, exercised against a deliberately wrong stand-in for the real function ----

test('PROOF: the absent-path assertion fails against a launcher that always pushes', () => {
  const alwaysPush = (cmakeArgs) => { cmakeArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=/oops'); return cmakeArgs; };
  assert.throws(() => {
    assert.deepStrictEqual(alwaysPush([...BASE_ARGS]), BASE_ARGS);
  }, 'a broken always-push implementation must fail the byte-identical check, or that check is worthless');
});

test('PROOF: the opt-out assertion fails against a launcher that ignores CLODE_TJS_CCACHE=0', () => {
  const ignoresOptOut = ({ findToolFn }) => findToolFn('ccache');
  const fakeFindToolFn = () => '/fake/bin/ccache';
  assert.throws(() => {
    assert.strictEqual(ignoresOptOut({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn }), null);
  }, 'an implementation that never reads CLODE_TJS_CCACHE must fail the opt-out check');
});

test('PROOF: the present-path exactly-once assertion fails against a launcher pushed twice', () => {
  const pushesTwice = (cmakeArgs, path) => {
    if (path) { cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); }
    return cmakeArgs;
  };
  const out = pushesTwice([...BASE_ARGS], '/fake/bin/ccache');
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.throws(() => {
    assert.strictEqual(hits.length, 1);
  }, 'a double-push must fail the exactly-once check');
});

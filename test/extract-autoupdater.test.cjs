'use strict';
// Unit tests for the two autoupdater patches in extract-claude-js.cjs. Both must
// drive the notify-only check (globalThis.__clodeCheckUpdate, installed by the
// PRELUDE) and NEVER spawn/redirect to $CLODE_SELF. Synthetic bundle strings in
// the style of the other extractor-anchor tests, plus the real 2.1.179 native
// fixture. End-to-end correctness (right version compared, notice renders) is
// verified in Task 6 against a real bundle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  patchAutoupdater,
  patchNativeAutoupdater,
} = require('../libexec/extract-claude-js.cjs');

// --- native path -------------------------------------------------------------
// Real shape: `try{let S=await <fn>(<arg>),w={...,VERSION:"x.y.z",...}` — the
// current version is a string literal KEY in the metadata object bound as the
// next declarator. The patch reads that literal via a lookahead and passes it to
// __clodeCheckUpdate, so the compared `current` is the real running version.

test('native autoupdater is redirected to the notify check, not CLODE_SELF', () => {
  const body = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let S=await zmt(d),w={FOO:"bar",VERSION:"2.1.218",BAZ:"q"};A=1;';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.match(out, /__clodeCheckUpdate/);
  assert.doesNotMatch(out, /CLODE_SELF/);
  assert.doesNotMatch(out, /__clodeNativeUpdate/);
  // the real running version reaches the check as a literal argument
  assert.match(out, /__clodeCheckUpdate\("2\.1\.218"\)/);
  // the metadata object binding is preserved unchanged after the call
  assert.match(out, /,w=\{FOO:"bar",VERSION:"2\.1\.218",BAZ:"q"\};/);
});

test('native autoupdater patch applies to the real 2.1.179 fixture', () => {
  const fx = fs.readFileSync(
    path.join(__dirname, 'fixtures/autoupdater/native-2.1.179.js'), 'latin1');
  const [out, applied] = patchNativeAutoupdater(fx);
  assert.strictEqual(applied, true);
  assert.match(out, /__clodeCheckUpdate\("2\.1\.179"\)/);
  assert.doesNotMatch(out, /CLODE_SELF/);
});

test('native autoupdater patch is fail-loud: no match -> unchanged, applied false', () => {
  const body = 'nothing native here';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, body);
});

test('native autoupdater patch is fail-loud: two matches -> unchanged, applied false', () => {
  const one = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let S=await zmt(d),w={VERSION:"2.1.218"};';
  const [out, applied] = patchNativeAutoupdater(one + one);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, one + one);
});

// --- pkg-manager path --------------------------------------------------------

test('pkg-manager autoupdater no longer spawns CLODE_SELF', () => {
  const body = 'M("tengu_pkg_manager_auto_updater_start",X);let[a,...b]=cmd,c=await run(';
  const [out, applied] = patchAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.doesNotMatch(out, /CLODE_SELF/);
  assert.match(out, /__clodeCheckUpdate/);
});

test('pkg-manager autoupdater matches the real direct-form (2.1.210+) shape', () => {
  const body = 'M("tengu_pkg_manager_auto_updater_start",FFf);'
    + 'let[GTT,...J5x]=WTT;let cxn=await Qn(GTT,J5x,{cwd:x});';
  const [out, applied] = patchAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.doesNotMatch(out, /CLODE_SELF/);
  assert.match(out, /__clodeCheckUpdate/);
});

test('pkg-manager autoupdater patch is fail-loud: no match -> unchanged, applied false', () => {
  const body = 'no pkg autoupdater here';
  const [out, applied] = patchAutoupdater(body);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, body);
});

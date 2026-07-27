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
  patchUpdateHint,
  patchUpdateNotice,
} = require('../libexec/extract-claude-js.cjs');

// A synthetic diagnostics-builder return in the real 2.1.218 shape: the current
// version is the SECOND field (`version:<id>`), the warnings array is `warnings:<id>`,
// both in scope at the anchor. patchUpdateNotice must splice an awaited check +
// conditional push BEFORE the `return{`.
const DIAG_RETURN =
  'return{installationType:t,version:r,installationPath:n,invokedBinary:o,'
  + 'configInstallMethod:c,autoUpdates:x,hasUpdatePermissions:u,lastUpdateResult:m,'
  + 'multipleInstallations:i,warnings:s,packageManager:f,ripgrepStatus:p}';

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

// --- update remediation hint -------------------------------------------------

test('update remediation hint is clode wording, not npm', () => {
  const body = 'let m="Update available! Run: npm i -g @anthropic-ai/claude-code";';
  const [out, applied] = patchUpdateHint(body);
  assert.strictEqual(applied, true);
  assert.match(out, /managed by clode/i);
  assert.doesNotMatch(out, /npm i -g @anthropic-ai\/claude-code/);
});

test('update remediation hint patch is fail-loud: no match -> unchanged, applied false', () => {
  const body = 'no npm remediation string here';
  const [out, applied] = patchUpdateHint(body);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, body);
});

// --- update notice on the installation-warnings surface ----------------------
// Where the three-state notify reaches the user (Task 6): the native autoupdater
// widget only renders install outcomes, so the notice rides the doctor/status
// warnings list instead — an awaited check keyed off the in-scope version, pushing
// at most one {issue,fix} onto the in-scope warnings array.

test('update notice fires the check with the in-scope version and pushes onto warnings', () => {
  const [out, applied] = patchUpdateNotice(DIAG_RETURN);
  assert.strictEqual(applied, true);
  // splice lands BEFORE the return
  assert.match(out, /__clodeCheckUpdate\(r\).*return\{installationType:/s);
  // fires the notify-only check with the current version var (r) in scope
  assert.match(out, /var __clodeUpd=await globalThis\.__clodeCheckUpdate\(r\)/);
  // newer -> names the version, current -> nothing, unknown -> couldn't-check note
  assert.match(out, /newer.*__clodeUpd\.latestVersion.*is available/s);
  assert.match(out, /clode build/);
  assert.match(out, /unknown.*couldn/s);
  // pushes onto the builder's own warnings array (s), never "Auto-update failed"
  assert.match(out, /s\.push\(/);
  assert.doesNotMatch(out, /Auto-update failed/);
});

test('update notice patch is fail-loud: no match -> unchanged, applied false', () => {
  const body = 'return{installationType:t,warnings:s,packageManager:f}'; // no version field
  const [out, applied] = patchUpdateNotice(body);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, body);
});

test('update notice patch is fail-loud: two matches -> unchanged, applied false', () => {
  const [out, applied] = patchUpdateNotice(DIAG_RETURN + ';' + DIAG_RETURN);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, DIAG_RETURN + ';' + DIAG_RETURN);
});

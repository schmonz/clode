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

// UPSTREAM DRIFT, 2026-08-21 (2.1.238). The installer call grew arguments:
// 2.1.218 emitted `let S=await zmt(d)` (one identifier), 2.1.238 emits
// `let v=await E3t(p,!1,o)` — three args, one of them the minified boolean `!1`.
// The old single-identifier anchor stopped matching, so the redirect silently
// stopped applying: everything still builds and PONGs while a built target
// would try to install upstream over itself. Exactly the 2.1.207 -> 2.1.210
// class at the pkg-manager site, which went unnoticed for weeks.
test('native autoupdater matches a MULTI-ARGUMENT installer call (2.1.238 shape)', () => {
  const body = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let v=await E3t(p,!1,o),w={ISSUES_EXPLAINER:"x",PACKAGE_URL:"y",VERSION:"2.1.238",FEEDBACK_CHANNEL:"z"};A=1;';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.match(out, /__clodeCheckUpdate\("2\.1\.238"\)/);
  // the whole call, arguments included, is what gets replaced
  assert.doesNotMatch(out, /E3t\(/);
  // and the metadata binding is still left verbatim
  assert.match(out, /,w=\{ISSUES_EXPLAINER:"x"/);
});

// The single-argument form must KEEP working — widening the anchor must not
// re-pin us onto only the newest shape.
test('native autoupdater still matches the SINGLE-argument call (2.1.218 shape)', () => {
  const body = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let S=await zmt(d),w={VERSION:"2.1.218"};A=1;';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.match(out, /__clodeCheckUpdate\("2\.1\.218"\)/);
});

test('native autoupdater patch is left-bounded: an ENGINE_VERSION decoy before the real VERSION field does not capture the decoy', () => {
  // Without a left boundary on `VERSION:"`, the non-greedy `.{0,300}?` lookahead
  // locks onto the FIRST `VERSION:"` substring it finds — including the tail of
  // `ENGINE_VERSION:"` — and would silently capture "9.9.9" instead of the real
  // "2.1.230". This is the exact bug the negative lookbehind
  // `(?<![A-Za-z0-9_$])` fixes: it requires the char before VERSION:" to not be
  // an identifier char, so the lookahead skips the decoy and finds the real,
  // standalone VERSION field instead.
  const body = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let S=await zmt(d),w={ENGINE_VERSION:"9.9.9",VERSION:"2.1.230",BAZ:"q"};A=1;';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, true);
  assert.match(out, /__clodeCheckUpdate\("2\.1\.230"\)/);
  assert.doesNotMatch(out, /__clodeCheckUpdate\("9\.9\.9"\)/);
});

test('native autoupdater patch is fail-loud on a decoy-only body: no real standalone VERSION -> unchanged, applied false', () => {
  // No real standalone VERSION field anywhere (only the ENGINE_VERSION decoy) ->
  // zero matches -> fail-loud skip, never a silent wrong-version injection.
  const body = 'M("tengu_native_auto_updater_start",{});try{'
    + 'let S=await zmt(d),w={ENGINE_VERSION:"9.9.9",BAZ:"q"};A=1;';
  const [out, applied] = patchNativeAutoupdater(body);
  assert.strictEqual(applied, false);
  assert.strictEqual(out, body);
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

// THESE FIXTURES ARE COPIED FROM A REAL BUNDLE, and that is the whole point.
//
// The test that used to live here invented its own input —
//   'let m="Update available! Run: npm i -g @anthropic-ai/claude-code";'
// — a string upstream has NEVER emitted in any released version. So it passed
// happily for months while the hook it tested did nothing at all, on every build,
// for every user. A fixture you wrote yourself only proves your regex matches your
// regex. Bytes below are from the carved 2.1.241 CLI; the shapes go back to 1.0.100.
const METADATA = '{ISSUES_EXPLAINER:"report the issue at https://github.com/anthropics/claude-code/issues",'
  + 'PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://code.claude.com/docs/en/overview",'
  + 'VERSION:"2.1.241",FEEDBACK_CHANNEL:"https://github.com/anthropics/claude-code/issues",'
  + 'BUILD_TIME:"2026-08-22T22:46:48Z",GIT_SHA:"c87e2742fc9ad269ec8920460d00a091b1e410f0",'
  + 'DD_SOURCEMAP_GROUP:"darwin"}';
const REAL_TPL = 'npm i -g ${' + METADATA + '.PACKAGE_URL}';
const REAL_JSX = 'Og.jsxs(S,{bold:!0,children:["npm i -g ",' + METADATA + '.PACKAGE_URL]})';
const REAL_LOCAL = 'cd ~/.claude/local && npm update ${' + METADATA + '.PACKAGE_URL}';

test('update remediation hint: the template-substitution shape', () => {
  const [out, applied, n] = patchUpdateHint(REAL_TPL);
  assert.strictEqual(applied, true);
  assert.strictEqual(n, 1);
  assert.strictEqual(out, 'clode build (this binary is managed by clode)');
});

test('update remediation hint: the JSX-child shape stays a quoted string', () => {
  const [out, applied, n] = patchUpdateHint(REAL_JSX);
  assert.strictEqual(applied, true);
  assert.strictEqual(n, 1);
  // Must remain a valid array element, not bare text spliced into JSX children.
  assert.strictEqual(out, 'Og.jsxs(S,{bold:!0,children:["clode build (this binary is managed by clode)"]})');
});

test('update remediation hint: the ~/.claude/local shape', () => {
  const [out, applied, n] = patchUpdateHint(REAL_LOCAL);
  assert.strictEqual(applied, true);
  assert.strictEqual(n, 1);
  assert.strictEqual(out, 'clode build (this binary is managed by clode)');
});

test('update remediation hint: all shapes together leave NO npm advice behind', () => {
  const body = `x=${REAL_TPL};y=${REAL_JSX};z="${REAL_LOCAL}";`;
  const [out, applied, n] = patchUpdateHint(body);
  assert.strictEqual(applied, true);
  assert.strictEqual(n, 3);
  // The property that actually matters, and the one nobody ever checked.
  assert.doesNotMatch(out, /npm i -g /);
  assert.doesNotMatch(out, /npm update /);
});

test('update remediation hint: the OLD invented literal is NOT what upstream ships', () => {
  // Guards against someone "restoring" the old anchor. If this ever starts matching,
  // upstream changed shape and the re-pin above needs revisiting on purpose.
  const invented = 'let m="Update available! Run: npm i -g @anthropic-ai/claude-code";';
  const [out, applied] = patchUpdateHint(invented);
  assert.strictEqual(applied, false, 'upstream does not emit a folded literal');
  assert.strictEqual(out, invented);
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

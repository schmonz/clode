'use strict';
// The bytecode-regen tripwire (scripts/build-tjs.mjs): cmake compiles
// src/bundles/c/** — quickjs bytecode arrays txiki git-tracks pre-compiled —
// NOT the esbuilt src/bundles/js/** a src/js/** patch actually lands in.
// Regenerating the .c arrays from the .js bundles used to be an opt-in
// (CLODE_TJS_REGEN=1) nobody ever set, so no build on any target ever picked
// up a patch: verified with patches/txiki-timer-unref.patch, which built
// clean and changed nothing until regen became the default.
//
// This file guards two things structurally regressing back to that silent
// drop: (1) regen is opt-OUT, not opt-IN — the exact shape of the original
// bug; (2) a cross build regenerates via a HOST-NATIVE tjsc (canonical-LE
// makes its output valid for every target), not the target's own
// non-executable tjsc. Both are checked against the REAL source text (the
// house pattern — test/tjs-build-hermeticity.test.cjs, test/win-*-guards.
// test.cjs — grepping shipped behavior, not a reimplementation of it), plus
// the pure fingerprint/freshness functions are extracted and run directly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.mjs'), 'utf8');

// Brace-balanced extraction (same as test/tjs-build-hermeticity.test.cjs) —
// a plain non-greedy regex breaks the moment the function body contains its
// own `}`.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.mjs`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractConstLine(src, name) {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start > -1, `const ${name} not found in build-tjs.mjs`);
  const end = src.indexOf('\n', start);
  return src.slice(start, end);
}

// Loads the REAL pure helpers out of build-tjs.mjs (not a reimplementation),
// same principle as loadCheckHermeticDeps in the hermeticity test file.
function loadBytecodeHelpers() {
  const src = [
    extractConstLine(buildTjsSrc, 'FINGERPRINT_RE'),
    extractFunction(buildTjsSrc, 'bundleFingerprint'),
    extractFunction(buildTjsSrc, 'fingerprintTrailer'),
    extractFunction(buildTjsSrc, 'bytecodeIsFresh'),
    extractFunction(buildTjsSrc, 'bytecodeBundlePairs'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function('crypto',
    `${src}\nreturn { bundleFingerprint, fingerprintTrailer, bytecodeIsFresh, bytecodeBundlePairs };`);
  return factory(crypto);
}

// ---- pure-function behavior ------------------------------------------------

test('bytecodeBundlePairs: 6 fixed core/internal pairs plus one per stdlib file', () => {
  const { bytecodeBundlePairs } = loadBytecodeHelpers();
  const pairs = bytecodeBundlePairs(['assert.js', 'ffi.js']);
  assert.strictEqual(pairs.length, 8);
  const polyfills = pairs.find((p) => p.outC === 'src/bundles/c/core/polyfills.c');
  assert.deepStrictEqual(polyfills, {
    outC: 'src/bundles/c/core/polyfills.c',
    name: 'tjs:internal/polyfills',
    prefix: 'tjs__',
    inJs: 'src/bundles/js/core/polyfills.js',
  });
  const assertPair = pairs.find((p) => p.inJs === 'src/bundles/js/stdlib/assert.js');
  assert.deepStrictEqual(assertPair, {
    outC: 'src/bundles/c/stdlib/assert.c',
    name: 'tjs:assert',
    prefix: 'tjs__',
    inJs: 'src/bundles/js/stdlib/assert.js',
  });
});

test('bundleFingerprint/fingerprintTrailer/bytecodeIsFresh: fresh matches, tampered JS does not, missing trailer does not', () => {
  const { bundleFingerprint, fingerprintTrailer, bytecodeIsFresh } = loadBytecodeHelpers();
  const jsBytes = Buffer.from('export const x = 1;\n');
  const fp = bundleFingerprint(jsBytes);
  assert.strictEqual(fp, crypto.createHash('sha256').update(jsBytes).digest('hex'));

  const cText = `/* File generated automatically by the QuickJS compiler. */\nconst x = 1;\n${fingerprintTrailer('src/bundles/js/core/x.js', fp)}`;
  assert.strictEqual(bytecodeIsFresh(cText, jsBytes), true, 'a freshly-stamped trailer must read as fresh');

  const tamperedJs = Buffer.from('export const x = 2;\n');
  assert.strictEqual(bytecodeIsFresh(cText, tamperedJs), false,
    'a .c stamped for the OLD .js content must read as stale once the .js changes — this is the exact shape of the original bug (patch changes src/js/**, src/bundles/c/** silently keeps shipping the old bytecode)');

  const noTrailer = '/* File generated automatically by the QuickJS compiler. */\nconst x = 1;\n';
  assert.strictEqual(bytecodeIsFresh(noTrailer, jsBytes), false,
    'a .c with no fingerprint at all (e.g. pristine upstream, never regenerated) must read as stale, not fresh-by-default');
});

// ---- source-level: regen must be opt-OUT, never opt-IN --------------------

// The exact shape of the original defect: CLODE_TJS_REGEN was read as
// `=== '1'` (opt-in, nobody set it, regen never ran on any build). Reusable
// so the PROOF test below can show it actually catches that shape.
function assertRegenDefaultsOn(src) {
  assert.doesNotMatch(src, /process\.env\.CLODE_TJS_REGEN\s*===\s*'1'/,
    'regen must not be gated behind an opt-IN (=== \'1\') flag — that is the original silent-drop defect');
  assert.match(src, /const regenOptOut = process\.env\.CLODE_TJS_REGEN === '0';/,
    'regen must be gated behind an explicit opt-OUT (=== \'0\') flag, i.e. ON by default');
}

test('build-tjs: bytecode regen defaults ON (opt-out, not opt-in)', () => {
  assertRegenDefaultsOn(buildTjsSrc);
});

// PROOF that the assertion above is not a tautology: run it against the
// ACTUAL old text this file replaced (git show HEAD~ or the report's own
// quote of it) and confirm it throws — if it didn't, the check above would
// also pass with the defect back in place.
test('build-tjs: PROOF — the default-on check catches the old opt-in gate', () => {
  const oldBuggyText = "const forceRegen = process.env.CLODE_TJS_REGEN === '1';\nif (forceRegen) {\n  regenerate();\n}\n";
  assert.throws(() => assertRegenDefaultsOn(oldBuggyText), /opt-IN/);
});

test('build-tjs: the opt-out is LOUD (logs which patches will not take effect)', () => {
  const idx = buildTjsSrc.indexOf("regenOptOut = process.env.CLODE_TJS_REGEN === '0'");
  assert.ok(idx > -1);
  const after = buildTjsSrc.slice(idx, idx + 800);
  assert.match(after, /if\s*\(\s*regenOptOut\s*\)\s*\{/);
  assert.match(after, /console\.error/);
  assert.match(after, /SKIPPED/);
});

// ---- source-level: cross builds must use a HOST-NATIVE tjsc ---------------

test('build-tjs: a cross build regenerates via a host-native tjsc, not the target buildDir', () => {
  const idx = buildTjsSrc.indexOf('let tjsc;');
  assert.ok(idx > -1, 'the tjsc-selection block was not found');
  const window = buildTjsSrc.slice(idx, idx + 500);
  assert.match(window, /if\s*\(\s*crossFile\s*\)\s*\{\s*\n\s*tjsc = buildHostTjsc\(/,
    'a cross build (crossFile set) must call buildHostTjsc(), never build tjsc in the (non-executable) target buildDir');
  assert.match(window, /run\('cmake', \['--build', buildDir, '--target', 'tjsc'/,
    'a NATIVE build (no crossFile) may still build tjsc directly in buildDir, since it is host-executable there');
});

test('build-tjs: buildHostTjsc never uses a cross toolchain file (plain host compiler)', () => {
  const src = extractFunction(buildTjsSrc, 'buildHostTjsc');
  assert.doesNotMatch(src, /CLODE_TJS_CROSS_FILE|CMAKE_TOOLCHAIN_FILE/,
    'the host-native tjsc build must never route through a cross toolchain file — the whole point is a binary THIS host can exec');
  assert.match(src, /throw new Error/,
    'a host that cannot build its own native tjsc must fail loudly, not silently skip regen for that target');
});

// ---- source-level: the tripwire is a hard build failure, not a warning ----

test('build-tjs: the freshness tripwire throws (fails the build) on stale bytecode, unless explicitly opted out', () => {
  const idx = buildTjsSrc.indexOf('the tripwire (requirement 4)');
  assert.ok(idx > -1, 'the tripwire section banner was not found');
  const window = buildTjsSrc.slice(idx, idx + 1200);
  assert.match(window, /if\s*\(\s*!regenOptOut\s*\)\s*\{/);
  assert.match(window, /bytecodeIsFresh\(/);
  assert.match(window, /throw new Error\(`bytecode regen: STALE/);
});

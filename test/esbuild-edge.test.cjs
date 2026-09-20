'use strict';
// Phase 4c-2b. The bytecode-regen DEPENDS edge (fixupTjsCmakeBytecodeRules, phase 4c-2)
// only reaches 2 of 18 bundles — the two tjsc compiles straight from src/js/**
// (internal/path, worker-bootstrap). The other 16 (4 JS_BUNDLES + the stdlib files) pass
// through esbuild FIRST, and esbuild is a prebuilt PLATFORM BINARY: the source phase's own
// header comment (scripts/build-tjs.cjs, above esbuildBundles) explains that a `--build-only`
// guest (the T2 VM legs sync the patched tree into a BSD/Solaris guest) carries the
// HOST-platform esbuild binary in its node_modules and cannot exec it, so the build phase
// never re-esbuilds — it can only verify. Verifying honestly requires evidence the source
// phase actually built from what is on disk NOW, which is what this file's first subject
// (esbuildBundles' manifest, task 1) records. THE SECOND HALF OF THIS FILE (task 2) is the
// check that reads it back — `assertEsbuildInputsCurrent`, called from the `--build-only`
// branch in scripts/build-tjs.cjs right after the existing presence check — proven against
// its own small fixtures the same way: a real hash mismatch throws and names the file, a
// missing manifest refuses rather than assuming currency, and an unrelated bundle's input
// is never blamed for a sibling bundle's edit.
//
// WHY A SYNTHETIC FIXTURE, NOT THE REAL ~785MB VENDOR CHECKOUT: test/tjs-bytecode-e2e.test.cjs
// already pays that cost (a CoW copy + a real cmake configure+build) to prove the tjsc half
// of this same phase; esbuildBundles' own shape needs none of cmake, qjs, or tjsc, only a
// real esbuild binary and a handful of real src/js/** files with a real import between two
// of them. A 7-file fixture proves the same claim (a bundle's recorded inputs are a genuine
// SUBSET, not everything on disk) at a scale a reviewer can read in one sitting, and runs in
// under a second instead of tens of seconds. It reuses the pinned esbuild already installed
// by any real build on this box (symlinking its node_modules in) rather than re-installing
// it, and SKIPS — rather than reaching for the network — when no such checkout is warm.
//
// PRECISION IS THE CLAIM UNDER TEST, not merely "a file got written". A glob over
// src/js/** would make an unrelated edit fail the eventual --build-only check — a false
// positive, and false positives are how a gate trains people to bypass it. So the fixture
// below is built to make that distinguishable: uuid.js imports a helper file lonely.js does
// NOT, and the assertions require uuid.js's recorded inputs to include the helper while
// lonely.js's do not — the metafile-per-invocation shape (esbuild's own --metafile, not a
// directory walk) is what the real implementation must use to get this right.
//
// AVOIDING test/guards-population.cjs's scanner-shaped classifier ON PURPOSE: this file
// DOES read scripts/build-tjs.cjs by a repo-rooted path (the extractFunction/extractConst
// pattern test/bytecode-rule.test.cjs and test/tjs-bytecode-regen.test.cjs already use), but
// every assertion below judges the BEHAVIOR of running the extracted code against a fixture
// it built itself (spy-captured esbuild argv, files this test wrote, hashes this test
// computed) — never a pattern-match verdict derived from build-tjs.cjs's own source bytes.
// (Careful with this paragraph itself: the classifier scans raw file bytes, comments
// included, for its own trigger shapes — so much as spelling one of them out here would
// count as this file "deriving a finding".) That keeps classifyTestFile()'s finding-derived
// signal false, so this is not "one more unmigrated scanner" the phase-5 ratchet has to
// carry; it is the same shape test/tjs-bytecode-e2e.test.cjs already established (a live
// run, not a scan).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8');

// Brace-balanced extraction — same house pattern as test/tjs-bytecode-regen.test.cjs /
// test/bytecode-rule.test.cjs / test/tjs-bytecode-e2e.test.cjs: a plain non-greedy regex
// breaks the moment the function body contains its own '}'.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.cjs`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Same idea, bracket-balanced, for the one non-function declaration esbuildBundles needs:
// `const JS_BUNDLES = [ ... ];`.
function extractConst(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `const ${name} not found in build-tjs.cjs`);
  const bracketStart = source.indexOf('[', start);
  let depth = 0;
  for (let i = bracketStart; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        const semi = source.indexOf(';', i);
        assert.ok(semi > -1, `no terminating ';' found for const ${name}`);
        return source.slice(start, semi + 1);
      }
    }
  }
  throw new Error(`unbalanced brackets extracting ${name}`);
}

// A third extraction shape, task 2: a plain quoted-string declaration (`const NAME =
// '...';`, no braces/brackets to balance) — used for ESBUILD_INPUTS_MANIFEST, which both
// esbuildBundles (the writer) and assertEsbuildInputsCurrent (the reader, below) share.
// Evaluates the declaration text itself rather than retyping the literal, so a rename in
// build-tjs.cjs cannot leave this file quietly checking a path that is no longer real.
function extractStringConst(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `const ${name} not found in build-tjs.cjs`);
  const semi = source.indexOf(';', start);
  assert.ok(semi > -1, `no terminating ';' found for const ${name}`);
  const decl = source.slice(start, semi + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`${decl}\nreturn ${name};`)();
}

// Loads the REAL esbuildBundles (+ its free dependencies, including the manifest-path
// constant it now writes to — task 2 added ESBUILD_INPUTS_MANIFEST as a shared literal, so
// esbuildBundles no longer has the path inline) out of build-tjs.cjs, wired to a
// caller-supplied `run` so the test can spy on the exact argv esbuild was invoked with
// without reimplementing any of the bundling logic.
function loadEsbuildBundles(run) {
  const src = [
    extractConst(buildTjsSrc, 'JS_BUNDLES'),
    `const ESBUILD_INPUTS_MANIFEST = ${JSON.stringify(extractStringConst(buildTjsSrc, 'ESBUILD_INPUTS_MANIFEST'))};`,
    extractFunction(buildTjsSrc, 'ensureEsbuild'),
    extractFunction(buildTjsSrc, 'esbuildBundles'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'crypto', 'os', 'run', 'console', 'process',
    `${src}\nreturn esbuildBundles;`)(fs, path, crypto, os, run, console, process);
}

// The pinned esbuild any real build already installed into the shared vendor checkout's
// node_modules (see ensureEsbuild in build-tjs.cjs) — reused read-only via a symlink so
// this test never re-installs or hits the network. Returns null (never throws) when no
// warm checkout exists, which the test below turns into a SKIP, the same convention
// test/tjs-bytecode-e2e.test.cjs uses for the same precondition.
function findRealEsbuildNodeModules() {
  const vendorRoot = tjsVendorParentDir();
  const nm = path.join(vendorRoot, 'txiki.js', 'node_modules');
  const bin = path.join(nm, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  return fs.existsSync(bin) ? nm : null;
}

test('esbuildBundles records a precise, hashed, forward-slashed input manifest in the checkout', (t) => {
  const realNodeModules = findRealEsbuildNodeModules();
  if (!realNodeModules) {
    t.skip('no warm txiki.js vendor checkout with esbuild installed — run a real '
      + 'build-tjs.cjs source phase once to populate ~/.cache/clode/tjs-vendor');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-edge-'));
  try {
    // A minimal fixture standing in for the real ~91-file src/js/** tree: exactly the four
    // JS_BUNDLES entry points (extracted verbatim above, so their paths must be real here),
    // plus two stdlib files — one that imports a helper OUTSIDE stdlib/, one that imports
    // nothing — so the manifest's per-bundle precision is distinguishable from "every file
    // on disk, glommed together by a glob".
    for (const rel of ['src/js/polyfills', 'src/js/core', 'src/js/run-main', 'src/js/run-repl',
      'src/js/internal', 'src/js/stdlib']) {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'src/js/polyfills/index.js'), 'export const polyfills = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/js/core/index.js'), 'export const core = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/js/run-main/index.js'), 'export const runMain = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/js/run-repl/repl.js'), 'export const repl = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/js/internal/shared-helper.js'), 'export const helperVal = 42;\n');
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'),
      "import { helperVal } from '../internal/shared-helper.js';\nexport const uuid = helperVal;\n");
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/lonely.js'), 'export const lonely = true;\n');
    const totalFilesOnDisk = 7;

    fs.symlinkSync(realNodeModules, path.join(dir, 'node_modules'), 'dir');

    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push(args);
      return execFileSync(cmd, args, { stdio: 'pipe', ...opts });
    };
    const esbuildBundles = loadEsbuildBundles(run);

    esbuildBundles(dir);

    // Every esbuild invocation carried --metafile — the mechanism the real implementation
    // must use (per-invocation, esbuild's own accounting of what it read) rather than a
    // directory walk over src/js/**.
    assert.strictEqual(calls.length, 6, 'expected 4 JS_BUNDLES + 2 stdlib invocations');
    for (const args of calls) {
      assert.ok(args.some((a) => a.startsWith('--metafile=')),
        `esbuild invocation missing --metafile: ${args.join(' ')}`);
    }

    // The manifest lives INSIDE the tree the guest actually receives (the same `dir` this
    // test passed to esbuildBundles), not some separately-configurable build/output
    // directory (CLODE_TJS_BUILD / CLODE_TJS_OUT, both OUTSIDE the checkout per this file's
    // own header) — a guest that only gets the synced source tree could never read it from
    // anywhere else.
    const manifestPath = path.join(dir, 'src/bundles/js/.clode-inputs.json');
    assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest must exist in the checkout');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const uuidOut = 'src/bundles/js/stdlib/uuid.js';
    const lonelyOut = 'src/bundles/js/stdlib/lonely.js';
    assert.ok(manifest[uuidOut], 'uuid.js bundle must be recorded');
    assert.ok(manifest[lonelyOut], 'lonely.js bundle must be recorded');

    const uuidKeys = Object.keys(manifest[uuidOut]).sort();
    const lonelyKeys = Object.keys(manifest[lonelyOut]).sort();
    // THE PRECISION CLAIM: uuid.js's recorded inputs are the two files it ACTUALLY
    // imports, not every file esbuildBundles happened to touch this run.
    assert.deepStrictEqual(uuidKeys, ['src/js/internal/shared-helper.js', 'src/js/stdlib/uuid.js']);
    assert.deepStrictEqual(lonelyKeys, ['src/js/stdlib/lonely.js']);
    assert.ok(uuidKeys.length < totalFilesOnDisk,
      `expected a plausible subset, got ${uuidKeys.length} of ${totalFilesOnDisk} files on disk`);

    // Hash spot-check: the recorded sha256 for the shared helper matches a hash this test
    // computed independently off the same bytes on disk.
    const helperBytes = fs.readFileSync(path.join(dir, 'src/js/internal/shared-helper.js'));
    const expectedHash = crypto.createHash('sha256').update(helperBytes).digest('hex');
    assert.strictEqual(manifest[uuidOut]['src/js/internal/shared-helper.js'], expectedHash);
    const lonelyBytes = fs.readFileSync(path.join(dir, 'src/js/stdlib/lonely.js'));
    assert.strictEqual(manifest[lonelyOut]['src/js/stdlib/lonely.js'],
      crypto.createHash('sha256').update(lonelyBytes).digest('hex'));

    // Every path — output key and input key alike — must be forward-slashed so the
    // manifest compares identically after an unchanged host->guest sync onto a POSIX
    // guest, regardless of which OS the source phase ran on.
    for (const outKey of Object.keys(manifest)) {
      assert.strictEqual(outKey.indexOf('\\'), -1, `backslash in output key: ${outKey}`);
      for (const inKey of Object.keys(manifest[outKey])) {
        assert.strictEqual(inKey.indexOf('\\'), -1, `backslash in input key: ${inKey}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- task 2: assertEsbuildInputsCurrent, the check that reads the manifest back ----
//
// Same extraction discipline as loadEsbuildBundles above (extractStringConst, defined
// beside extractConst): the REAL function, pulled out of build-tjs.cjs and run against
// fixtures this test built itself, never a reimplementation of its hashing logic.

function loadAssertEsbuildInputsCurrent() {
  const fnSrc = extractFunction(buildTjsSrc, 'assertEsbuildInputsCurrent');
  const manifestName = extractStringConst(buildTjsSrc, 'ESBUILD_INPUTS_MANIFEST');
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'crypto', 'ESBUILD_INPUTS_MANIFEST',
    `${fnSrc}\nreturn assertEsbuildInputsCurrent;`)(fs, path, crypto, manifestName);
}

function withFixtureTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-edge-currency-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeManifestFixture(dir, manifest) {
  const manifestName = extractStringConst(buildTjsSrc, 'ESBUILD_INPUTS_MANIFEST');
  fs.mkdirSync(path.join(dir, path.dirname(manifestName)), { recursive: true });
  fs.writeFileSync(path.join(dir, manifestName), JSON.stringify(manifest));
}

function sha(text) {
  return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
}

test('assertEsbuildInputsCurrent: recorded hashes matching every input on disk does not throw', () => {
  const check = loadAssertEsbuildInputsCurrent();
  withFixtureTree((dir) => {
    fs.mkdirSync(path.join(dir, 'src/js/stdlib'), { recursive: true });
    const uuidSrc = 'export const uuid = 1;\n';
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), uuidSrc);
    writeManifestFixture(dir, {
      'src/bundles/js/stdlib/uuid.js': { 'src/js/stdlib/uuid.js': sha(uuidSrc) },
    });
    check(dir, ['src/bundles/js/stdlib/uuid.js']);
  });
});

// THE ACCEPTANCE, AT FUNCTION SCOPE: editing the recorded input after the bundle was
// esbuilt from it — the exact shape of a `--build-only` guest handed a tree whose
// src/js/** moved on since the source phase ran — must throw, and must NAME the file. Prior
// to task 2, this same setup (a --build-only run over a bundle whose input on disk no
// longer matches what it was esbuilt from) produced exit 0 and an unchanged engine; the
// live, real-checkout demonstration of that is this task's report, not this fixture — this
// proves the mechanism the real `--build-only` branch now calls.
test('PROOF: an edited src/js/** input makes assertEsbuildInputsCurrent throw, naming the file', () => {
  const check = loadAssertEsbuildInputsCurrent();
  withFixtureTree((dir) => {
    fs.mkdirSync(path.join(dir, 'src/js/stdlib'), { recursive: true });
    const original = 'export const uuid = 1;\n';
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), original);
    writeManifestFixture(dir, {
      'src/bundles/js/stdlib/uuid.js': { 'src/js/stdlib/uuid.js': sha(original) },
    });
    // The bundle on disk still reflects `original` (nothing re-esbuilds it here); only the
    // input it was recorded against has since changed — the one thing --build-only can see.
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), 'export const uuid = 2;\n');
    assert.throws(() => check(dir, ['src/bundles/js/stdlib/uuid.js']), /uuid\.js/);
    assert.throws(() => check(dir, ['src/bundles/js/stdlib/uuid.js']), /--source-only/);
  });
});

// PRECISION, the same claim task 1 proved for the manifest writer, now proved for the
// reader: editing one bundle's recorded input must not blame a sibling bundle whose own
// recorded input never changed — a glob-shaped check would fail both and train people to
// bypass it (see this file's header).
test('assertEsbuildInputsCurrent blames only the bundle whose recorded input actually changed', () => {
  const check = loadAssertEsbuildInputsCurrent();
  withFixtureTree((dir) => {
    fs.mkdirSync(path.join(dir, 'src/js/stdlib'), { recursive: true });
    const uuidSrc = 'export const uuid = 1;\n';
    const lonelySrc = 'export const lonely = true;\n';
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), uuidSrc);
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/lonely.js'), lonelySrc);
    writeManifestFixture(dir, {
      'src/bundles/js/stdlib/uuid.js': { 'src/js/stdlib/uuid.js': sha(uuidSrc) },
      'src/bundles/js/stdlib/lonely.js': { 'src/js/stdlib/lonely.js': sha(lonelySrc) },
    });
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), 'export const uuid = 2;\n');
    let caught = null;
    try {
      check(dir, ['src/bundles/js/stdlib/uuid.js', 'src/bundles/js/stdlib/lonely.js']);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'an edited input must throw');
    assert.ok(caught.message.indexOf('uuid.js') > -1, `expected uuid.js named: ${caught.message}`);
    assert.ok(caught.message.indexOf('lonely.js') === -1,
      `lonely.js's untouched input must not be blamed: ${caught.message}`);
  });
});

// THE MANIFEST-ABSENCE RULING, demonstrated: a tree with no manifest at all (a checkout
// from before phase 4c-2b) REFUSES rather than assuming its bundles are current — the same
// choice assertBytecodeRulesPresent makes for the sibling premise on the bytecode edge, and
// for the same reason (this file's header on the currency check, scripts/build-tjs.cjs,
// states it in full). The remedy is one command, and this checks that command is the one
// actually named.
test('assertEsbuildInputsCurrent refuses (never warns-and-proceeds) when the manifest itself is missing', () => {
  const check = loadAssertEsbuildInputsCurrent();
  withFixtureTree((dir) => {
    fs.mkdirSync(path.join(dir, 'src/js/stdlib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), 'export const uuid = 1;\n');
    // No manifest written at all.
    assert.throws(() => check(dir, ['src/bundles/js/stdlib/uuid.js']), /--source-only/);
  });
});

// A vacuous `{}` per-bundle entry is not "nothing changed" — esbuildBundles can never
// emit a bundle with zero recorded inputs (every bundle records at least its own entry
// point), so an empty map is evidence the manifest was never written honestly for that
// bundle, not evidence of currency. Whole-branch review, Minor 8: this used to pass for
// free, which is exactly the shortcut a hand-rolled fixture (or a future writer bug)
// could ship by accident.
test('assertEsbuildInputsCurrent treats a bundle recorded with zero inputs as stale, not current', () => {
  const check = loadAssertEsbuildInputsCurrent();
  withFixtureTree((dir) => {
    fs.mkdirSync(path.join(dir, 'src/js/stdlib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/js/stdlib/uuid.js'), 'export const uuid = 1;\n');
    writeManifestFixture(dir, { 'src/bundles/js/stdlib/uuid.js': {} });
    assert.throws(() => check(dir, ['src/bundles/js/stdlib/uuid.js']), /zero inputs/);
  });
});

// ---- C1 (whole-branch review, BLOCKING): the call site, not just the function ----
//
// All the tests above extract `assertEsbuildInputsCurrent` with `new Function` and call
// it directly — they prove the CHECK works, never that scripts/build-tjs.cjs's real
// `--build-only` branch actually calls it. Deleting the call at the real call site left
// every test above green, which is literally what the reviewer did by hand to demonstrate
// the defect (see this phase's report). This is the sibling of
// test/tjs-bytecode-regen.test.cjs:376's `assertBytecodeRulesPresent(tjsDir)` call-site
// assertion, and follows the same pattern, including asserting the ORDERING the code
// comment above the call promises (presence, then currency) — the same comment explains
// why the declaration is not enough: `indexOf('assertEsbuildInputsCurrent(')` alone would
// match `function assertEsbuildInputsCurrent(` (the declaration) first, which is a
// property of nothing.
test('build-tjs: the esbuild-input currency check is actually CALLED from --build-only, after presence', () => {
  const idx = buildTjsSrc.indexOf('\n  assertEsbuildInputsCurrent(tjsDir, expected);');
  assert.ok(idx > -1, 'assertEsbuildInputsCurrent is never called from --build-only — a '
    + 'guest handed a stale esbuilt bundle would ship it at exit 0, the exact defect this '
    + 'phase exists to end, with every fixture-level test above still green');

  // The call must live in the SECOND `if (buildOnly) {` block (the verify-only branch;
  // the first, near the top of the file, is the BE-regen manifest writer) and after the
  // presence check (`if (missing.length) { throw ... }`) it is documented to follow.
  const ifBuildOnlyIdx = buildTjsSrc.lastIndexOf('if (buildOnly) {', idx);
  const presenceIdx = buildTjsSrc.indexOf('if (missing.length) {', ifBuildOnlyIdx);
  assert.ok(ifBuildOnlyIdx > -1, 'no enclosing `if (buildOnly) {` found before the call');
  assert.ok(presenceIdx > ifBuildOnlyIdx && presenceIdx < idx,
    'presence must be checked, in this order, BEFORE currency — the code comment above the '
    + 'call says exactly this ("Presence proven; now prove CURRENCY")');

  // Nothing expensive — in particular no re-esbuild, which --build-only can never do (see
  // the header above ensureEsbuild) — may run between the two checks. Plain indexOf
  // (never `.includes(`/`.match(`/`.test(`) on purpose: see this file's header on
  // avoiding test/guards-population.cjs's scanner-shaped classifier — this assertion
  // genuinely derives a finding from build-tjs.cjs's own bytes (it IS the call-site gate),
  // so it is written the same way test/tjs-bytecode-regen.test.cjs's sibling assertion is.
  const between = buildTjsSrc.slice(presenceIdx, idx);
  assert.ok(between.indexOf('esbuildBundles(') === -1 && between.indexOf('run(') === -1,
    'nothing may run between the presence check and the currency check');

  // The call must be inside the if-branch, not spilled into the `else { esbuildBundles(...) }`
  // that handles the non-buildOnly (source) phase.
  const elseIdx = buildTjsSrc.indexOf('} else {', idx);
  assert.ok(elseIdx > idx, 'the currency check must be inside the --build-only branch');
  assert.ok(buildTjsSrc.slice(idx, elseIdx).indexOf('esbuildBundles(') === -1,
    'only the success log may follow the currency check before the branch closes');
});

// ---- the OTHER input the bundle step has, and the call site that refuses without it ----
//
// Everything above is about esbuild: that it runs, that what it read is recorded, that a
// later phase can prove the recording still matches. None of it notices that esbuild also
// needs SOMETHING TO BUNDLE — txiki's own JS dependency tree (web-streams-polyfill, uuid,
// getopts and the rest), which nothing in this build installs on purpose; the single
// `npm install --no-save esbuild@0.28.1` in ensureEsbuild materializes it as a side effect
// of running inside a checkout whose package.json declares it. scripts/bundle-inputs-gate.cjs
// is the refusal that names both inputs, and test/bundle-inputs-gate.test.cjs proves it
// against fixtures. These two rows prove the parts a fixture cannot: that the real source
// phase CALLS it, in the right place, and that the pin is one pin and not two.
const { ESBUILD_PIN } = require('../scripts/bundle-inputs-gate.cjs');

test('the esbuild pin is spelled the same in ensureEsbuild and in the input gate', () => {
  // ensureEsbuild keeps its own `const pin` INSIDE the function on purpose (this file
  // evaluates that function standalone, so a free name declared elsewhere would be a
  // ReferenceError there — a lifted constant broke exactly this row once). That is two
  // spellings of one load-bearing pin, which is a staleness risk unless something holds
  // them together. This is that something.
  //
  // Plain indexOf, no regex — see this file's header on staying clear of
  // test/guards-population.cjs's scanner-shaped classifier, whose trigger shapes include
  // the regex idioms this would otherwise reach for.
  const fnSrc = extractFunction(buildTjsSrc, 'ensureEsbuild');
  const marker = "const pin = '";
  const at = fnSrc.indexOf(marker);
  assert.ok(at > -1, 'ensureEsbuild no longer declares its pin as `const pin = \'...\'` — if '
    + 'it moved, move this check with it rather than deleting it');
  const end = fnSrc.indexOf("'", at + marker.length);
  assert.strictEqual(fnSrc.slice(at + marker.length, end), ESBUILD_PIN,
    'ensureEsbuild installs one esbuild and the input gate tells operators to supply '
    + 'another — one of the two refusals is now a lie');
});

test('build-tjs: the bundle-input gate is CALLED in the source phase, before the fixups', () => {
  const callIdx = buildTjsSrc.indexOf('const refusal = bundleInputsRefusal({');
  assert.ok(callIdx > -1, 'nothing calls bundleInputsRefusal — a cold checkout would once '
    + 'again get the whole patch stack and ~50 source fixups applied to it and THEN fail '
    + 'from inside the bundle step, naming neither the pin nor the dep tree, with every '
    + 'fixture-level test in test/bundle-inputs-gate.test.cjs still green');
  assert.ok(buildTjsSrc.indexOf('if (refusal) throw new Error(refusal);', callIdx) > callIdx,
    'the verdict must be thrown; a computed-and-ignored refusal is the gate not existing');

  // Placement, both edges. It reads the PATCHED tree (six txiki-*.patch files edit
  // src/js/**, which is what the package list is derived from), and it must still land
  // before the first source fixup — the whole point is that a cold checkout is refused
  // before the work, not after it.
  const patchesIdx = buildTjsSrc.indexOf("applyPatches(path.join(tjsDir, 'deps/quickjs'), 'quickjs-ng-');");
  const firstFixupIdx = buildTjsSrc.indexOf('fixupLwsDragonflySoPriority(tjsDir);');
  assert.ok(patchesIdx > -1 && firstFixupIdx > patchesIdx, 'the source phase changed shape; '
    + 'this row anchors on the patch stack and the first fixup');
  assert.ok(callIdx > patchesIdx && callIdx < firstFixupIdx,
    'the gate must sit between the patch stack and the first source fixup');

  // And in the SOURCE branch, never the --build-only one: a guest that only receives a
  // synced tree has no npm, no network and no business being told to install anything.
  const buildOnlyIdx = buildTjsSrc.lastIndexOf('if (buildOnly) {', callIdx);
  const elseIdx = buildTjsSrc.indexOf('} else {', buildOnlyIdx);
  assert.ok(elseIdx > -1 && callIdx > elseIdx,
    'the gate belongs in the else (source) branch, not in --build-only');
});

// ---- the call site ----------------------------------------------------------
// THE THIRD CALL-SITE ROW, and it lives HERE beside the other two rather than next to the
// script it is about (test/provision-bundle-inputs.test.cjs) for a concrete reason: that
// file asserts with assert.match, and reading build-tjs.cjs's bytes from it would make it
// scanner-shaped to test/guards-population.cjs's classifier — an exclusion to write where
// no exclusion is needed. This file already dodges the trigger shapes on purpose (see the
// header) and already reads buildTjsSrc, so the row costs nothing here.
//
// WHAT IT GUARDS is the failure this repo has hit most: machinery that is perfectly
// correct and never CALLED. scripts/provision-bundle-inputs.sh is what stops the refusal
// two rows up from being the end of the story on a node-free host.

test('build-tjs CALLS the provisioner, in the source branch, immediately before the gate', () => {
  const callIdx = buildTjsSrc.indexOf('\n  provisionBundleInputs(tjsDir);');
  assert.ok(callIdx > -1, 'nothing calls provisionBundleInputs — a cold checkout would be '
    + 'refused instead of provisioned, with every row above still green');

  // BEFORE the gate, and with nothing between them: the gate re-derives what is missing
  // from the tree the provisioner just wrote, which is what makes a partial provision
  // report itself by name instead of as an exit code.
  const gateIdx = buildTjsSrc.indexOf('const refusal = bundleInputsRefusal({');
  assert.ok(gateIdx > callIdx, 'the provisioner must run BEFORE the refusal it exists to '
    + 'make unnecessary; after it, it could only ever provision a tree nothing will use');

  // In the SOURCE branch. A --build-only guest receives a synced tree and has no business
  // fetching anything — the same rule the gate itself follows.
  const buildOnlyIdx = buildTjsSrc.lastIndexOf('if (buildOnly) {', callIdx);
  const elseIdx = buildTjsSrc.indexOf('} else {', buildOnlyIdx);
  assert.ok(elseIdx > -1 && callIdx > elseIdx,
    'provisioning belongs in the else (source) branch, not in --build-only');

  // THE ASYNC-BOUNDARY RULE, PINNED. scripts/build-tjs.cjs has exactly one async
  // continuation, opened for provisionCosmocc's await, and test/build-tjs-continuation-scope
  // .test.cjs exists because moving that opener once produced a ReferenceError at module
  // load on every qemu guest-bake leg. Provisioning sits ABOVE it and is therefore
  // synchronous BY CONSTRAINT: the fetch lives in a POSIX sh sibling reached through
  // spawnSync precisely so no `await` is introduced here. An `await` on this line would
  // force that boundary up past the --regen-only exit again.
  const openerIdx = buildTjsSrc.indexOf('\n(async () => {');
  assert.ok(openerIdx > -1, 'the async continuation opener is gone; this row is now blind');
  assert.ok(callIdx < openerIdx,
    'provisionBundleInputs is called above the async continuation, so it must stay '
    + 'synchronous — see its header');
  const body = buildTjsSrc.slice(buildTjsSrc.indexOf('function provisionBundleInputs(dir) {'),
    buildTjsSrc.indexOf('\n}\n', buildTjsSrc.indexOf('function provisionBundleInputs(dir) {')));
  assert.ok(body.indexOf('await ') === -1,
    'provisionBundleInputs must not await: it runs above the one async continuation this '
    + 'file has, and introducing an await here moves the boundary that '
    + 'test/build-tjs-continuation-scope.test.cjs exists to protect');
});

'use strict';
// Bytecode regen (scripts/build-tjs.cjs): cmake compiles
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
// the pure bundle-pair table is extracted and run directly.
//
// WHAT MOVED IN PHASE 4c-2, and where its property went. Regeneration stopped
// being an imperative step this script performs and became a cmake dependency
// edge (fixupTjsCmakeBytecodeRules). Two things this file used to assert went
// with it:
//
//   * the fingerprint/freshness helpers (bundleFingerprint, bytecodeIsFresh)
//     and the pre-compile tripwire (assertBytecodeFresh). Their property was
//     "a .c older than its .js must not reach the compiler". That is now the
//     DEPENDS edge in the injected rule — cmake rebuilds the .c instead of
//     detecting that it is stale, so staleness is not a state to detect. The
//     edge is gated by test/bytecode-rule.test.cjs.
//   * "--regen-only calls the SAME regen function a normal build calls". A
//     normal build now calls no such function at all; --regen-only is the ONE
//     remaining imperative caller (its netbsd-sparc guest has no node and its
//     cmake gets no CLODE_HOST_TJSC). The property that actually prevented the
//     sparc divergence survives and is re-pointed below: both emitters read
//     their argv from the same bytecodeBundlePairs() table.
//
// The provenance trailer regenBytecodeArrays still stamps is NOT a freshness
// check and is not asserted here: it carries no hash, exists only so
// spike/quickjs/qemu/ci-guest-bake.sh can refuse an unregenerated tree, and is
// guarded there by test/engine-api-floor.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8');

// Brace-balanced extraction (same as test/tjs-build-hermeticity.test.cjs) —
// a plain non-greedy regex breaks the moment the function body contains its
// own `}`.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.cjs`);
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

// Loads the REAL pure helpers out of build-tjs.cjs (not a reimplementation),
// same principle as loadCheckHermeticDeps in the hermeticity test file.
function loadBytecodeHelpers() {
  const src = extractFunction(buildTjsSrc, 'bytecodeBundlePairs');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${src}\nreturn { bytecodeBundlePairs };`);
  return factory();
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

// The pair table is the ONE source both emitters read: this file's
// regenBytecodeArrays loop (for --regen-only) and the cmake COMMAND lines
// fixupTjsCmakeBytecodeRules injects (for every other build). A second
// hand-maintained copy of these pairs is precisely how the netbsd-sparc bake
// came to ship an engine missing the JS half of its own patches, so the fixup
// must be HANDED this table, never grow its own.
test('build-tjs: the injected cmake rules are built from bytecodeBundlePairs, not a second list', () => {
  const idx = buildTjsSrc.indexOf('fixupTjsCmakeBytecodeRules(tjsDir');
  assert.ok(idx > -1, 'the fixup is never called — the cmake rules would never be injected');
  const window = buildTjsSrc.slice(idx, idx + 400);
  assert.match(window, /bytecodeBundlePairs\(/,
    'the fixup must be handed the shared bundle-pair table, not a list it builds itself');
  assert.match(window, /src\/js\/stdlib/,
    'the stdlib half of the table is a function of the PATCHED tree\'s listing, read at fixup time');
});

test('build-tjs: cmake is told where the host tjsc is, or the injected rules stay inert', () => {
  // The rules are wrapped in if(CLODE_HOST_TJSC); without this -D they are not
  // emitted at all and the build silently compiles the committed arrays again
  // — the exact defect, reintroduced by omission.
  assert.match(buildTjsSrc, /-DCLODE_HOST_TJSC=\$\{tjsc\}/,
    'the target configure must pass the selected host tjsc to cmake');
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

// ---- the freshness tripwire is GONE, deliberately -------------------------
//
// It asserted "no stale array reaches the compiler" by re-reading a hash
// stamped into each .c. That was the right shape while regeneration was an
// imperative step that could be skipped or mis-ordered. It is the wrong shape
// now: the .c is a cmake OUTPUT whose DEPENDS names the .js, so a stale array
// is not a condition to detect — it is a condition the build graph rebuilds
// away before any compile can consume it. Keeping the detector would assert a
// state the build can no longer be in, and would put a second mechanism in
// charge of bytecode freshness, which is how the original drop stayed hidden.
//
// This test therefore checks the property that REPLACED it: nothing may compile
// the bundle arrays until the regeneration target has run.
test('build-tjs: the regeneration is ordered BEFORE the compile by the graph, not by a check after it', () => {
  const fnSrc = extractFunction(buildTjsSrc, 'fixupTjsCmakeBytecodeRules');
  assert.match(fnSrc, /add_dependencies\(tjs clode_bytecode\)/,
    'the LIBRARY that compiles the arrays must depend on the regeneration target: the stdlib '
    + 'arrays reach the compiler only via #include inside src/builtins.c, so they have no '
    + 'source-list edge of their own and would otherwise compile in parallel with their own rewrite');
  assert.match(fnSrc, /DEPENDS [^\n]*\$\{inJs\}/,
    'each rule must name its .js input as a DEPENDS — that edge IS the staleness answer');
});

// ---- generation is single-sourced: --regen-only reads THE SAME table -------
//
// The netbsd-sparc in-guest bake is the one build path in the matrix that does
// not run build-tjs.cjs for its compile (a 512MB sun4m guest with no node), and
// it hand-rolled its own cmake invocation with NO regen at all — so it shipped
// an engine carrying the C half of txiki-engine-module-meta.patch and not the
// JS half, and died 927s into the blobulate with "this engine does not report
// moduleMeta". The fix is --regen-only: the runner regenerates the tree before
// tarring it, and the guest compiles a complete tree. These assertions exist so
// that "the sparc tree is regenerated by a SECOND implementation" cannot come
// back.
//
// PHASE 4c-2 NARROWED WHAT "SAME" MEANS, and it is worth being exact about it,
// because the looser claim is now false. --regen-only no longer calls the same
// FUNCTION a normal build calls: a normal build calls none, it lets cmake's
// rules run. What the two share — and all they ever really needed to share — is
// the bundle-pair TABLE, asserted above. This block keeps the rest: --regen-only
// must still build a host tjsc, still go through the shipped regen
// implementation rather than a copy, and still stop before the target compile.

// WHAT THIS TEST CANNOT SEE, recorded where the next reader will look. Every
// assertion below is on SOURCE TEXT: it proves the block is WRITTEN to call those
// functions, not that the calls RESOLVE. Phase 4c1 moved them inside
// build-tjs's async continuation while `if (regenOnly)` stayed at module top
// level, making every one of them a guaranteed ReferenceError at module load —
// and this test stayed green through it, because the text never changed. A text
// assertion is structurally incapable of catching a scope error. The execution
// half now lives in test/build-tjs-continuation-scope.test.cjs, which RUNS
// --regen-only; keep both, they check different properties.
test('build-tjs: --regen-only regenerates through the shipped implementation, over the shared pair table', () => {
  assert.match(buildTjsSrc, /const regenOnly = process\.argv\.includes\('--regen-only'\);/);
  const idx = buildTjsSrc.indexOf('if (regenOnly) {');
  assert.ok(idx > -1, 'the --regen-only block was not found');
  const window = buildTjsSrc.slice(idx, idx + 1200);
  assert.match(window, /buildHostTjsc\(/,
    '--regen-only must build a host-native tjsc (canonical-LE makes its output valid for the guest target)');
  assert.match(window, /bytecodeBundlePairs\(/,
    '--regen-only must drive the SAME pair table the injected cmake rules are built from — a second '
    + 'list of bundles is the divergence that shipped the sparc engine without its JS patches');
  assert.match(window, /regenBytecodeArrays\(/,
    '--regen-only must call the shipped regen implementation, not a copy of its tjsc invocations');
  assert.match(window, /process\.exit\(0\)/, '--regen-only must stop before the target compile');
});

test('build-tjs: --regen-only takes --build-only\'s source handling (never re-patches a patched tree)', () => {
  assert.match(buildTjsSrc, /const buildOnly = process\.argv\.includes\('--build-only'\) \|\| regenOnly;/,
    'a second way to find the checkout is a second way to get it wrong — regenOnly must ride buildOnly');
});

test('build-tjs: exactly ONE place invokes tjsc over the bundle pairs', () => {
  const calls = buildTjsSrc.match(/run\(tjsc, \['-m', '-s'/g) || [];
  assert.strictEqual(calls.length, 1,
    'the tjsc invocation was copied — that is the shape that let the sparc bake diverge');
});

// ---- the generated C identifier comes from the INPUT PATH argument ----------
//
// tjsc names the emitted symbol after the file it compiled: get_c_name
// (src/qjsc.c:191) takes everything after the last '/', trims one extension,
// and maps '-' to '_'. It knows nothing about '\'. So an ABSOLUTE WINDOWS path
// has no '/' at all, the whole thing becomes the identifier, and the generated
// C is:
//
//   const uint32_t tjs__internal_D:\a\_temp\tjs_vendor\...\path_size = 89;
//
// which MSVC reports as one C2143 for the drive colon plus one C2017 per
// backslash — 100 errors across all 18 bundles, in files nobody wrote, 250
// build steps after the mistake. Windows never hit it before 0c72693 made
// bytecode regen unconditional, because tjsc is EXCLUDE_FROM_ALL upstream and
// nothing built it; every Windows engine until now compiled the COMMITTED
// arrays, which is precisely the silent patch-drop 0c72693 exists to end. So
// "skip regen on Windows" is not a fix — passing a repo-relative path is.
//
// This is reproducible off Windows: '\' is a legal POSIX filename character.

const BYTECODE_SYMBOL_CASES = [
  ['src/js/internal/path.js', 'path'],
  ['src/bundles/js/core.js', 'core'],
  ['src/bundles/js/stdlib/getopts.js', 'getopts'],
  ['src/js/worker-bootstrap.js', 'worker_bootstrap'],       // '-' becomes '_'
  ['/abs/posix/src/js/internal/path.js', 'path'],           // POSIX abs is fine
  // The Windows shapes, which is why the argument must be relative:
  ['D:\\a\\_temp\\tjs-vendor\\txiki.js\\src\\js\\internal\\path.js',
    'D:\\a\\_temp\\tjs_vendor\\txiki.js\\src\\js\\internal\\path'],
];

test('build-tjs: bytecodeSymbolBase mirrors tjsc get_c_name, including the Windows failure', () => {
  const fn = new Function(`${extractFunction(buildTjsSrc, 'bytecodeSymbolBase')}; return bytecodeSymbolBase;`)();
  for (const [input, want] of BYTECODE_SYMBOL_CASES) {
    assert.strictEqual(fn(input), want, `bytecodeSymbolBase(${JSON.stringify(input)})`);
  }
});

test('build-tjs: tjsc is handed the repo-relative inJs, never the absolute inAbs', () => {
  const idx = buildTjsSrc.indexOf('for (const { outC, name, prefix, inJs } of bundlePairs)');
  assert.ok(idx > -1, 'the bytecode regen loop was not found');
  const loop = buildTjsSrc.slice(idx, idx + 2600);
  const call = loop.split('\n').find((l) => l.includes("run(tjsc, ['-m'"));
  assert.ok(call, 'the tjsc invocation was not found');
  assert.match(call, /prefix, inJs\]/,
    'tjsc must receive inJs (repo-relative, forward slashes) — inAbs is an absolute path, '
    + 'and on Windows that leaks into the generated C identifier');
  assert.match(loop, /cwd: tjsDir/, 'a relative input only resolves because cwd is tjsDir');
  assert.match(loop, /declares the wrong symbol/,
    'the regen loop must assert the emitted symbol, so this fails where the file is produced');
});

// The REAL reference, when one is reachable: run tjsc itself and confirm the
// identifier derivation above is not merely our model of it. Set CLODE_TJSC to
// a built tjsc to enable. Asserting against a model of the tool is how the
// model drifts from the tool.
// Resolved, not merely read from the environment. CLODE_TJSC wins if set; otherwise
// look where scripts/build-tjs.cjs actually puts tjsc — CLODE_TJS_BUILD, else
// <local scratch>/clode-tjs-build/<target-token>/build/tjsc (build-tjs.cjs:3220 and
// its header). Reading the env var alone meant this reference test skipped on every
// box that had built an engine but had not exported a variable nobody documents
// outside this file: dark, while saying "set CLODE_TJSC" as though the tool were
// absent. Same defect as test/graph-runner.test.cjs's engine gate, fixed the same day.
function findTjsc() {
  const explicit = process.env.CLODE_TJSC;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  let root;
  try {
    root = process.env.CLODE_TJS_BUILD
      || path.join(require('../scripts/build-scratch.cjs').scratchRoot(), 'clode-tjs-build');
  } catch { return null; }
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const cand = path.join(root, d, 'build', 'tjsc');
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}
const TJSC = findTjsc();

test('build-tjs: real tjsc agrees — a backslash path breaks the symbol, a relative one does not',
  { skip: TJSC ? false : 'no tjsc: neither CLODE_TJSC nor a built tjsc under '
    + "build-tjs.cjs's build root (CLODE_TJS_BUILD, else <scratch>/clode-tjs-build/*/build/tjsc). "
    + 'Build an engine with `node scripts/build-tjs.cjs`, or set CLODE_TJSC=<path>.' }, () => {
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const fn = new Function(`${extractFunction(buildTjsSrc, 'bytecodeSymbolBase')}; return bytecodeSymbolBase;`)();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tjsc-sym-'));
    fs.mkdirSync(path.join(dir, 'src/js/internal'), { recursive: true });
    const rel = 'src/js/internal/path.js';
    fs.writeFileSync(path.join(dir, rel), 'export const x = 1;\n');
    const winName = 'D:\\a\\_temp\\tjs-vendor\\txiki.js\\src\\js\\internal\\path.js';
    fs.writeFileSync(path.join(dir, winName), 'export const x = 1;\n');

    const gen = (inArg, out) => {
      const r = spawnSync(TJSC, ['-m', '-s', '-o', out, '-n', 'tjs:internal/path', '-p', 'tjs__internal_', inArg],
        { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `tjsc failed: ${r.stderr}`);
      // The declaration only — the byte count is the bytecode payload's size and
      // is not what this is about.
      const decl = fs.readFileSync(path.join(dir, out), 'utf8').split('\n')[4];
      return decl.replace(/ = \d+;$/, '');
    };

    assert.strictEqual(gen(rel, 'good.c'), 'const uint32_t tjs__internal_path_size',
      'a repo-relative input must yield the plain symbol');
    // And the model predicts the broken one exactly, which is what lets the
    // regen-time assertion name the real problem instead of guessing.
    assert.strictEqual(gen(winName, 'bad.c'), `const uint32_t tjs__internal_${fn(winName)}_size`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

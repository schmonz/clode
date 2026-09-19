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
const os = require('node:os');
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
// Reusable so the PROOF below can watch it reject the real regression — the
// house rule for this file (see assertRegenDefaultsOn) and the repo's standing
// constraint: a negative assertion nobody has seen go red is not yet a gate.
function assertFixupDrivenByPairTable(src) {
  const idx = src.indexOf('fixupTjsCmakeBytecodeRules(tjsDir');
  assert.ok(idx > -1, 'the fixup is never called — the cmake rules would never be injected');
  const window = src.slice(idx, idx + 400);
  assert.match(window, /bytecodeBundlePairs\(/,
    'the fixup must be handed the shared bundle-pair table, not a list it builds itself');
  assert.match(window, /src\/js\/stdlib/,
    'the stdlib half of the table is a function of the PATCHED tree\'s listing, read at fixup time');
}

test('build-tjs: the injected cmake rules are built from bytecodeBundlePairs, not a second list', () => {
  assertFixupDrivenByPairTable(buildTjsSrc);
});

test('build-tjs: PROOF — the pair-table check rejects a second, hand-written bundle list', () => {
  // The sparc divergence in miniature: the fixup handed a literal list instead
  // of the shared table, which is how one emitter came to know about bundles
  // the other did not.
  const handRolled = "fixupTjsCmakeBytecodeRules(tjsDir, [\n"
    + "  { outC: 'src/bundles/c/core/core.c', inJs: 'src/bundles/js/core/core.js' },\n"
    + ']);\n';
  assert.throws(() => assertFixupDrivenByPairTable(handRolled), /shared bundle-pair table/);
  // And the other polarity: not calling the fixup at ALL is the defect itself.
  assert.throws(() => assertFixupDrivenByPairTable('// nothing here\n'), /never called/);
});

function assertHostTjscHandedToCmake(src) {
  // The rules are wrapped in if(CLODE_HOST_TJSC); without this -D they are not
  // emitted at all and the build silently compiles the committed arrays again
  // — the exact defect, reintroduced by omission.
  assert.match(src, /-DCLODE_HOST_TJSC=\$\{[^}]*tjsc[^}]*\}/,
    'the target configure must pass the selected host tjsc to cmake');
}

// ---- the -D VALUE IS A PATH, and it is the first one on the Windows leg ----
//
// Every other `-D` build-tjs.cjs pushes on the native MSVC path is flag text.
// This one is a PATH: on win32 the selected tjsc is <buildDir>\tjsc.exe, and the
// value is substituted into the injected rule's COMMAND and into its DEPENDS,
// where cmake must match it against a file it already knows by its own
// normalized spelling.
//
// WHAT WAS MEASURED, and why the obvious justification is NOT the one written
// here (cmake 4.3.3, Unix Makefiles, 2026-09-18): a backslash-bearing `-D` value
// is not eaten as escape sequences — it reaches CMakeCache.txt byte-for-byte and
// the generated recipe quotes it correctly. The same probe found the quiet half
// instead: a DEPENDS naming a path cmake cannot resolve produces no configure
// error and no build error; the rule just builds without that edge. Applied to
// the shipping shape, a DEPENDS cmake fails to match to the tjsc it was handed
// is a rule that silently stops rebuilding when tjsc changes.
//
// So this gate does not encode a reproduced Windows break. It encodes a
// deliberate removal of an untested variable from a hard-publisher path, for the
// cost of one replace(): tjsc is EXCLUDE_FROM_ALL upstream, so no Windows build
// ever produced a host-tjsc path to hand cmake until phase 4c-2 made
// regeneration a build rule — this has run on ZERO Windows legs, and
// windows-amd64/arm64 are hard publishers.
//
// Asserted over EVERY occurrence, not the one that exists today, so a second
// configure site added later cannot quietly pass a raw path.
function assertHostTjscPathNormalized(src) {
  const values = [...src.matchAll(/-DCLODE_HOST_TJSC=\$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(values.length > 0, 'no -DCLODE_HOST_TJSC= was found at all — the injected rules '
    + 'would stay inert and nothing would regenerate');
  for (const expr of values) {
    assert.match(expr, /^toCmakeCachePath\(/,
      `-DCLODE_HOST_TJSC=\${${expr}} hands cmake a raw, unnormalized path. On win32 that `
      + 'is D:\\a\\_temp\\...\\tjsc.exe, a spelling this repo has never once put through a '
      + 'Windows leg, and the value lands in the injected rule\'s DEPENDS as well as its '
      + 'COMMAND -- where a path cmake cannot match to the file it names costs the rule its '
      + 'rebuild edge with NO error at all (measured, cmake 4.3.3). Route it through '
      + 'toCmakeCachePath() like the existing site does');
  }
}

test('build-tjs: the host-tjsc path handed to cmake is backslash-free (Windows hard publishers)', () => {
  assertHostTjscPathNormalized(buildTjsSrc);
});

test('build-tjs: PROOF — the normalization check rejects a raw path in the -D', () => {
  // Exactly what the line looked like before this fix, and what a future second
  // configure site would be written as by default.
  const raw = "run('cmake', ['-S', tjsDir, '-B', buildDir, ...cmakeArgs, `-DCLODE_HOST_TJSC=${tjsc}`]);\n";
  assert.throws(() => assertHostTjscPathNormalized(raw), /hands cmake a raw, unnormalized path/);
  // And the other polarity: no -D at all is the inert-rules defect, not a pass.
  assert.throws(() => assertHostTjscPathNormalized('// nothing\n'), /no -DCLODE_HOST_TJSC= was found/);
});

test('build-tjs: toCmakeCachePath actually converts a Windows path (run, not grepped)', () => {
  const fn = new Function(`${extractFunction(buildTjsSrc, 'toCmakeCachePath')}; return toCmakeCachePath;`)();
  assert.strictEqual(fn('D:\\a\\_temp\\tjs-vendor\\build\\tjsc.exe'),
    'D:/a/_temp/tjs-vendor/build/tjsc.exe');
  // No-op on POSIX, which is what makes it safe to apply unconditionally.
  assert.strictEqual(fn('/Users/x/clode-tjs-build/t/build/tjsc'), '/Users/x/clode-tjs-build/t/build/tjsc');
});

test('build-tjs: cmake is told where the host tjsc is, or the injected rules stay inert', () => {
  assertHostTjscHandedToCmake(buildTjsSrc);
});

test('build-tjs: PROOF — the host-tjsc check rejects a configure that omits the -D', () => {
  // Exactly the shape a "tidy up the duplicate configure" refactor produces:
  // the second configure stays, the one argument that makes it matter is gone.
  // cmake would accept it silently and regenerate nothing.
  const omitted = "run('cmake', ['-S', tjsDir, '-B', buildDir, ...cmakeArgs]);\n";
  assert.throws(() => assertHostTjscHandedToCmake(omitted), /must pass the selected host tjsc/);
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
function assertGraphOrdersRegenBeforeCompile(fnSrc) {
  assert.match(fnSrc, /add_dependencies\(tjs clode_bytecode\)/,
    'the LIBRARY that compiles the arrays must depend on the regeneration target: the stdlib '
    + 'arrays reach the compiler only via #include inside src/builtins.c, so they have no '
    + 'source-list edge of their own and would otherwise compile in parallel with their own rewrite');
  assert.match(fnSrc, /DEPENDS [^\n]*\$\{inJs\}/,
    'each rule must name its .js input as a DEPENDS — that edge IS the staleness answer');
}

test('build-tjs: the regeneration is ordered BEFORE the compile by the graph, not by a check after it', () => {
  assertGraphOrdersRegenBeforeCompile(extractFunction(buildTjsSrc, 'fixupTjsCmakeBytecodeRules'));
});

test('build-tjs: PROOF — the ordering check rejects both ways the edge can go missing', () => {
  // (a) The shape that shipped in task 1 and read as correct: ordering the
  // EXECUTABLE. tjs-cli compiles only src/cli.c, so this leaves builtins.c —
  // which pulls every stdlib array by #include — free to compile in parallel
  // with the tjsc run rewriting those very files.
  const ordersExecutable = "    + '    add_dependencies(tjs-cli clode_bytecode)\\n'\n"
    + "    + `    DEPENDS \\${CMAKE_CURRENT_SOURCE_DIR}/${inJs} \\${CLODE_HOST_TJSC}\\n`\n";
  assert.throws(() => assertGraphOrdersRegenBeforeCompile(ordersExecutable),
    /LIBRARY that compiles the arrays/);

  // (b) A rule with no DEPENDS on its input: cmake would run it exactly once,
  // at first build, and never again when the .js changes — which is the
  // original silent drop with extra steps.
  const noDepends = "    + '    add_dependencies(tjs clode_bytecode)\\n'\n"
    + "    + `    DEPENDS \\${CLODE_HOST_TJSC}\\n`\n";
  assert.throws(() => assertGraphOrdersRegenBeforeCompile(noDepends),
    /that edge IS the staleness answer/);
});

// ---- the premise the deleted tripwire used to cover ------------------------
//
// Deleting a check is only safe once the thing that makes it unnecessary is
// itself guaranteed. Everything above assumes the vendored CMakeLists CARRIES
// the injected rules; cmake ignores a -D nothing reads, so on a tree without
// them the build succeeds, prints nothing, and ships pristine upstream
// bytecode — the original defect, restored, on one real path: a warm
// ~/.cache/clode/tjs-vendor prepared by a PRE-4c-2 --source-only, then
// --build-only, which by design never re-runs the fixups. assertBytecodeFresh
// used to cover that path by accident; assertBytecodeRulesPresent covers it on
// purpose.
//
// EXECUTED, not grepped: the function is pulled out of build-tjs.cjs and run
// against two real fixture trees, so this checks the BEHAVIOR rather than that
// a call is written somewhere (the distinction test/build-tjs-continuation-
// scope.test.cjs exists to keep honest).
function loadRulesPresentCheck() {
  const fnSrc = extractFunction(buildTjsSrc, 'assertBytecodeRulesPresent');
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', `${fnSrc}\nreturn assertBytecodeRulesPresent;`)(fs, path);
}

function withFixtureTree(cmakeText, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-rules-premise-'));
  try {
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), cmakeText);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('build-tjs: a tree that CARRIES the injected rules passes the premise check', () => {
  const check = loadRulesPresentCheck();
  withFixtureTree('add_executable(tjsc src/qjsc.c)\n# CLODE_BYTECODE_RULES\nif(CLODE_HOST_TJSC)\nendif()\n',
    (dir) => check(dir));
});

test('build-tjs: PROOF — a tree WITHOUT the rules throws instead of building pristine bytecode', () => {
  const check = loadRulesPresentCheck();
  // A pre-4c-2 vendored CMakeLists: every other fixup applied, no rules block.
  // This is the input that used to produce a green build and a patchless engine.
  const preFixup = 'add_executable(tjsc EXCLUDE_FROM_ALL src/qjsc.c)\n'
    + 'option(CLODE_ATOMIC_SHIM "..." OFF)\n';
  const err = withFixtureTree(preFixup, (dir) => {
    try { check(dir); } catch (e) { return e; }
    return null;
  });
  assert.ok(err, 'a tree with no CLODE_BYTECODE_RULES block must throw, and did not — '
    + 'that silence is exactly the defect this phase exists to end');
  assert.match(err.message, /no CLODE_BYTECODE_RULES block/);
  assert.match(err.message, /FIX: on the host that prepared this tree, re-run the source phase/,
    'the error must name the remedy: a reader hitting this has a warm tree, not a broken repo');
  // Whole-branch review, I3: this fires on --build-only too (the CAUSE line above says
  // so), and a guest has no outbound DNS to clone with — the remedy must say WHERE to
  // run it, not just what to run.
  assert.match(err.message, /guest \(no outbound DNS, cannot clone\) cannot run this fix itself/);
  console.log(`PROOF captured rejection: ${err.message.split('\n')[0]}`);
});

test('build-tjs: the premise is checked on the regenerating path only, before the tjsc build', () => {
  // The CALL, not the declaration — `indexOf('assertBytecodeRulesPresent(')`
  // alone finds `function assertBytecodeRulesPresent(` first and then measures
  // the distance from the function's own body, which is not a property of
  // anything.
  const idx = buildTjsSrc.indexOf('\n  assertBytecodeRulesPresent(tjsDir);');
  assert.ok(idx > -1, 'the premise check is never called — the rules would be assumed present');
  // Ahead of the tjsc selection, i.e. ahead of the minutes buildHostTjsc costs.
  // Checked as "nothing EXPENSIVE happens in between" rather than "within N
  // characters": a length bound would go red on a comment edit and green on a
  // real reordering, which is the wrong way round.
  const tjscIdx = buildTjsSrc.indexOf('let tjsc;', idx);
  assert.ok(tjscIdx > idx, 'the premise check must come BEFORE the tjsc selection, not after it');
  const between = buildTjsSrc.slice(idx, tjscIdx);
  assert.doesNotMatch(between, /\brun\(|buildHostTjsc\(/,
    'nothing may run between the premise check and the tjsc selection — a tree that cannot '
    + 'regenerate should say so first, not after a full host qjs build');
  // NOT in the opt-out branch: there, compiling the committed arrays is the
  // requested behavior and demanding the marker would break it.
  const optOutIdx = buildTjsSrc.indexOf('if (regenOptOut) {');
  assert.ok(optOutIdx > -1 && optOutIdx < idx,
    'the premise check must be in the else (regenerating) branch, after the opt-out branch opens');
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

// ---- the provenance stamp: its PRODUCER was ungated, only its consumer -----
//
// spike/quickjs/qemu/ci-guest-bake.sh refuses to bake a tree whose
// src/bundles/c/core/*.c carry no `clode:bytecode-regen` trailer, and
// test/engine-api-floor.test.cjs gates that the bake keeps asking. Nothing
// gated the other end. Delete the appendFileSync in regenBytecodeArrays and
// this whole suite stays green while the netbsd-sparc bake fails at minute one
// with "served tree was NOT bytecode-regenerated" — a red leg whose cause is a
// line nobody was watching, in a file the guest cannot see.
//
// One assertion closes the asymmetry: the producer and the consumer are now
// both held.
//
// AND THE TRAILER MUST STAY HASH-FREE. It used to carry sha256=<bundle hash> so
// a build could ask "is this .c still the one this .js produces?". That question
// died with the imperative regen — every other leg now regenerates through a
// cmake DEPENDS edge, where a stale array is rebuilt rather than detected — and
// the bake's own comment says "do not put the hash back" in so many words. A
// hash here would be a SECOND mechanism claiming responsibility for bytecode
// freshness, which is how the original silent drop hid for as long as it did.
function assertRegenStampsProvenance(loopSrc) {
  assert.match(loopSrc, /fs\.appendFileSync\(outAbs, regenStampTrailer\(inJs\)\)/,
    'regenBytecodeArrays must stamp each regenerated .c with the clode:bytecode-regen '
    + 'provenance trailer — spike/quickjs/qemu/ci-guest-bake.sh refuses to bake a tree '
    + 'without it, and the netbsd-sparc guest has no other way to tell a regenerated tree '
    + 'from a pristine one (its cmake never gets a CLODE_HOST_TJSC, so the injected rules '
    + 'are inert there by design)');
}

function assertTrailerIsHashFree(trailerSrc) {
  assert.doesNotMatch(trailerSrc, /sha256|createHash|Fingerprint|fingerprint/,
    'the regen trailer must carry NO hash: it is provenance, not freshness. Freshness is '
    + 'the cmake DEPENDS edge now, and a second mechanism for it is exactly what phase '
    + '4c-2 deleted (ci-guest-bake.sh says "do not put the hash back")');
}

test('build-tjs: the regen loop STAMPS provenance (the guest bake\'s only signal)', () => {
  assertRegenStampsProvenance(extractFunction(buildTjsSrc, 'regenBytecodeArrays'));
});

test('build-tjs: the provenance trailer carries no hash', () => {
  assertTrailerIsHashFree(extractFunction(buildTjsSrc, 'regenStampTrailer'));
});

test('build-tjs: PROOF — the stamp checks reject a dropped stamp and a reintroduced hash', () => {
  // (a) The exact regression: the appendFileSync tidied away. Green suite, red
  // sparc leg, 1500km apart.
  const noStamp = "for (const { outC, name, prefix, inJs } of bundlePairs) {\n"
    + "    run(tjsc, ['-m', '-s', '-o', outAbs, '-n', name, '-p', prefix, inJs], { cwd: tjsDir });\n"
    + '  }\n';
  assert.throws(() => assertRegenStampsProvenance(noStamp), /must stamp each regenerated \.c/);

  // (b) The hash coming back, which is how a provenance marker grows into a
  // second freshness mechanism.
  const hashed = "function regenStampTrailer(inJs, js) {\n"
    + '  return `\\n/* clode:bytecode-regen src=${inJs} sha256=${crypto.createHash("sha256")'
    + '.update(js).digest("hex")} */\\n`;\n}\n';
  assert.throws(() => assertTrailerIsHashFree(hashed), /must carry NO hash/);
});

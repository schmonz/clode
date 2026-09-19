'use strict';
// ACCEPTANCE (spec §11.3, phase 4c-2) — the defect that motivated the whole phase, proven
// live: editing a real src/js/** input changes the compiled src/bundles/c/** bytecode
// array it feeds, through a REAL cmake build, with NO CLODE_TJS_REGEN (or any other flag)
// set anywhere in this file.
//
// THE INCIDENT this exists to close: cmake compiles src/bundles/c/** — quickjs bytecode
// arrays txiki git-tracks pre-compiled — not the src/js/** patches actually land in. A
// correct AbortSignal.timeout patch (patches/txiki-timer-unref.patch) built clean and
// changed nothing, because regeneration was gated behind CLODE_TJS_REGEN=1, an opt-in no
// caller ever set. Phase 4c-2's fix (fixupTjsCmakeBytecodeRules, scripts/build-tjs.cjs)
// makes each .c a cmake OUTPUT with a DEPENDS edge on its .js, so staleness is not a
// condition the build can be in — cmake rebuilds it away before anything can compile the
// old bytes. Every OTHER test file touching this (test/tjs-bytecode-regen.test.cjs,
// test/bytecode-rule.test.cjs) checks that shape on TEXT or on a synthetic fixture; this
// is the one file that drives the real vendored CMakeLists through a real cmake and reads
// back real bytes it did not fabricate.
//
// SCOPE, said plainly so a pass here does not get read as more than it is: this builds
// ONLY the host-native `tjsc` executable and the `clode_bytecode` custom target — never a
// whole engine. tjsc's sole dependency is the qjs static library (CMakeLists.txt:
// add_executable(tjsc EXCLUDE_FROM_ALL src/qjsc.c); target_link_libraries(tjsc qjs)),
// none of the libuv/mbedtls/libwebsockets/sqlite graph a full tjs-cli link needs — which
// is exactly why buildHostTjsc (extracted below, not reimplemented) exists in
// scripts/build-tjs.cjs: it is the SAME recipe a cross build already uses to get a
// host-executable tjsc. This proves the DEPENDS edge fires and rewrites the right .c
// bytes in under a minute; it does NOT prove the resulting engine still links or boots —
// that is test/build-tjs-no-node.test.cjs's job, the by-hand demonstration in this task's
// report, and the daily boot-smoke's.
//
// WHAT THIS DOES NOT PROVE, because the acceptance edits the one input shape that
// bypasses the remaining gap. The declarative graph this phase built stops at
// src/bundles/js/**: only 2 of the 18 bundles (internal/path, worker-bootstrap) are fed to
// tjsc straight from src/js/**, and those two are the ones the DEPENDS edges below name
// directly. The other 16 reach tjsc only after esbuild turns src/js/** into
// src/bundles/js/**, and THAT edge is still imperative and undeclared — `--source-only`
// re-runs esbuildBundles unconditionally so it is correct there, but `--build-only` does
// not re-esbuild at all. So on `--build-only`, editing e.g. src/js/stdlib/uuid.js still
// yields exit 0 and an unchanged engine: the original defect's exact shape, surviving for
// 16 of 18 bundles on that one path.
//
// This test edits src/js/internal/path.js, which is one of the two that bypass esbuild —
// genuinely "the smallest edit that reaches the compiled .c with no intervening build
// step", and also, honestly, the instance that does not exercise the gap. No CI leg
// reaches it (guests receive a synced tree, they never edit one), so it is a boundary
// rather than a live defect; declaring the esbuild edge is filed as phase 4c-3 work in
// BACKLOG.md, not done here. Read a pass here as "the tjsc DEPENDS edge is real and
// per-file", never as "no src/js/** edit can be silently dropped".
//
// AND IT DOES NOT RUN IN CI: this needs a warm vendor checkout, and no CI leg has one at
// test time, so every CI run takes the skip above. The CI backstop for the same underlying
// property is test/node-shim-timer-unref.test.cjs, which fails if the engine ships without
// the JS half of patches/txiki-timer-unref.patch — the very patch whose silent drop started
// this phase. This file is the mechanism proof; that one is the outcome alarm.
//
// NO CLODE_TJS_REGEN, ANYWHERE IN THIS FILE — read that as load-bearing, not incidental.
// This test never execs scripts/build-tjs.cjs and never even names that variable: cmake is
// driven directly, with the two commands a real build's regenerating branch issues
// (buildHostTjsc, then a second configure with -DCLODE_HOST_TJSC). That is a STRICTER form
// of "no flag set" than running build-tjs.cjs with an unset env var would be — there is no
// flag-reading code in the path at all for one to accidentally reintroduce.
//
// COST, stated because this is now a known-expensive member of the default suite, and
// stated as a measured RANGE rather than a point, which is the part that kept going wrong.
// Measured 2026-09-18 on an 8-core box, dominated by the one-time cold qjs+tjsc compile
// capped at 2 parallel jobs (see the `jobs` comment below for why not more):
//
//   run ALONE  (`node --test test/tjs-bytecode-e2e.test.cjs`)  ~32s, n=3, tight (31.9-32.4)
//   inside `npm test`                                          45-80s, n=11, contention-bound
//
// The in-suite figure is a deliberately LOOSE band, rounded outward past the extremes
// actually observed (46.4-74.9): this file competes with every other test file for the same
// cores, so what it costs depends on what happens to be running beside it, and any tight
// range quoted here will be wrong on somebody's next run. It already was, FOUR times — a
// guessed "60-90s" against BACKLOG.md's "~32s"; "up to ~40s", contradicted by the very next
// three-suite run; "55-61s", contradicted by the three green runs verifying it (48.5 / 62.3
// / 66.5); and "48-75s", contradicted by the next three (46.4 / 47.2 / 47.3). Four wrong
// point estimates is the argument for a band, so treat this one as an order of magnitude,
// not a budget. BACKLOG.md's phase 4c-2 entry carries the same two lines; change both.
//
// It is the ONLY file in test/ that drives a real native compiler+linker build rather than
// text/fixture assertions. Not gated behind an opt-in: the cost is bounded by the existing
// warm-checkout skip (nothing to build without one), and the property it proves does not
// exist anywhere else in the suite.
//
// COPY, NEVER MUTATE THE SHARED CHECKOUT. ~/.cache/clode/tjs-vendor/txiki.js (or wherever
// CLODE_TJS_VENDOR points) is the ONE checkout every build on this box patches/resets/
// re-patches from; a test that edited its src/js/** directly would corrupt every later
// build. test/build-tjs-no-node.test.cjs solved this first — CoW-copy into a mkdtemp, then
// operate on the copy alone — and copyCheckout below is that same approach, not a fresh
// design.
//
// QUIESCENCE, a real constraint on a PARALLEL suite, not a hypothetical: this test's copy
// is only correct if the shared checkout is not mid reset+re-patch (scripts/
// tjs-source-reset.cjs) from some OTHER build on the same host at the exact moment
// copyCheckout runs — proven, not guessed, by a reproduced 3-run flake. That reset opens
// TWO windows, not one (inspectCopy's header below has both, why the second is the wider,
// and why its evidence must be read out of the same file the assertion judges — a copy
// this size is not a snapshot): a half-applied tree missing a patch-created source, and a
// still-PRISTINE CMakeLists carrying no fixups at all. An occasional SKIP naming either
// symptom is that race, caught and reported honestly; it is the first place to look, not
// a mystery. Neither is a FAILURE — the one failure this precondition can produce is
// reserved for a CMakeLists that provably went THROUGH the bytecode fixup's position in
// the source phase and still has no CLODE_BYTECODE_RULES block, which means the fixup
// call itself is gone.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8');

// Brace-balanced extraction — identical to test/tjs-bytecode-regen.test.cjs's own copy
// (itself matching test/tjs-build-hermeticity.test.cjs): a plain non-greedy regex breaks
// the moment the function body contains its own '}', which buildHostTjsc's error message
// and dropStaleCmakeCache's console.log template both do.
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

// Loads the REAL host-native-tjsc recipe out of build-tjs.cjs (not a reimplementation of
// its cmake args, which is exactly the kind of second copy that let the sparc bake diverge
// from the rest of the matrix — see tjs-bytecode-regen.test.cjs's header). buildHostTjsc
// calls dropStaleCmakeCache (a sibling declaration, hoisted into the same Function body)
// and closes over fs/path/process plus the two free variables `run` and `jobs` this test
// supplies itself.
function loadBuildHostTjsc(run, jobs) {
  const src = [
    extractFunction(buildTjsSrc, 'dropStaleCmakeCache'),
    extractFunction(buildTjsSrc, 'buildHostTjsc'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'run', 'jobs', 'process',
    `${src}\nreturn buildHostTjsc;`)(fs, path, run, jobs, process);
}

// A throwaway COW copy of an EXISTING vendor checkout — never a virgin dir (see the file
// header). Verbatim the same recipe as test/build-tjs-no-node.test.cjs's copyCheckout:
// APFS `cp -c` / GNU `cp --reflink=auto` first (seconds for a ~785MB tree), a plain `cp -R`
// if that flag is rejected, and fs.cpSync as the last resort. Correctness never depends on
// which one ran, only the wall clock does.
function copyCheckout(src, dest) {
  const attempts = process.platform === 'darwin'
    ? [['-Rc'], ['-R']]
    : [['-R', '--reflink=auto'], ['-R']];
  for (const flags of attempts) {
    if (spawnSync('cp', [...flags, src, dest]).status === 0) return dest;
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// TORN-COPY DETECTION (fix round 1, ROOT-CAUSED, reproduced 3x by the coordinator across 3
// full-suite runs — not a one-off, and NOT the job-count contention this fix round also
// addresses; job count cannot make a FILE disappear). The observed failure:
// `CMake Error: Cannot find source file: src/mod_fs_sync.c`, ~40s into a run, from INSIDE
// buildHostTjsc's own configure. src/mod_fs_sync.c is not upstream — it is OURS, added by
// the patch stack. scripts/tjs-source-reset.cjs's resetCheckoutToPristine does `git
// checkout -- .` + `git clean -fd` against the SHARED checkout (tjsVendorParentDir())
// before applyPatches re-adds the patch-created files; a `--source-only` running ANYWHERE
// on this host (another test, a concurrent build) passes the shared tree through states
// where CMakeLists.txt already references src/mod_fs_sync.c (an early-order patch) while
// the file itself is momentarily absent (reset removed it, re-patching has not yet run).
// copyCheckout's clonefile()/cp -R walk is not a snapshot: if it runs during that window it
// faithfully copies the half-applied tree, and cmake fails exactly as above.
// (test/build-tjs-no-node.test.cjs's identical copyCheckout has the same exposure, on a
// smaller surface — it never configures cmake against what it copies.)
//
// So the copy is not guaranteed self-consistent, and must be CHECKED, not assumed. Returns
// which of its own CMakeLists.txt's listed sources are missing from the tree (empty when
// consistent) — a pure function of the copy, so the caller can run it once, retry the copy
// on failure, and run it again.
function copyMissingSources(tjsDir, cmakeText) {
  // The exact shape that broke: a bare `src/....c` source-list line inside
  // add_library(tjs STATIC ...)/add_executable(tjsc ...). Deliberately narrow (not every
  // path CMakeLists.txt could ever mention) — this is a targeted symptom check for the
  // proven failure mode, not a general build-graph validator.
  const listed = [...cmakeText.matchAll(/^ {4}(src\/[\w./-]+\.c)$/gm)].map((m) => m[1]);
  return listed.filter((f) => !fs.existsSync(path.join(tjsDir, f)));
}

// TORN-COPY DETECTION, WINDOW 2 — and the reason the evidence for it must come
// out of THE SAME FILE the assertion judges.
//
// resetCheckoutToPristine does `git checkout -- .` + `git clean -fd` and only
// THEN re-applies patches and ~50 fixups, with fixupTjsCmakeBytecodeRules near
// the END of that list. So the shared checkout passes through two torn states:
//
//   W1  CMakeLists.txt already references src/mod_fs_sync.c (an early-order
//       patch) while the file is still absent. copyMissingSources above sees
//       it -> retry -> skip. Closed in fix round 1. It shuts the moment that
//       early patch lands.
//   W2  CMakeLists.txt is PRISTINE UPSTREAM: it lists only upstream sources,
//       every one of which exists, so copyMissingSources returns [] and nothing
//       fires — but it carries no CLODE_BYTECODE_RULES block either, so the
//       premise assertion below FAILED with "the fixupTjsCmakeBytecodeRules
//       CALL was reverted", in a tree where nothing was reverted. W2 spans
//       reset -> patches -> 45 fixups, i.e. it is WIDER than W1, so the more
//       likely race produced the harder-to-read result.
//
// AND THE FIRST FIX FOR W2 WAS WRONG, caught by its own three-suite run
// (fix round 2, run 1 of 3): it took "is this tree fully patched?" from a
// marker in a DIFFERENT file (fixupQjscMsvcGetopt's shim in src/qjsc.c, the
// last fixup the source phase runs) and still failed — on a copy whose
// CMakeLists.txt was pristine while its src/qjsc.c carried the shim. That
// combination is not a state the source phase ever writes; it is a state
// copyCheckout CONSTRUCTS. cp/clonefile walks the tree over seconds and is not
// a snapshot, so two files in one copy can come from two different instants of
// the shared checkout. Cross-file evidence about a non-atomic copy is therefore
// worth nothing — and proving that took one real run, which is why it is
// written here rather than reasoned about again.
//
// SO THE EVIDENCE IS FILE-LOCAL: fixupTjsCmakeWinStack edits the SAME
// CMakeLists.txt and runs on the very next line after the bytecode fixup
// (build-tjs.cjs source phase), reading the text the bytecode fixup just wrote.
// Its marker therefore CANNOT appear in any single snapshot of that file
// without CLODE_BYTECODE_RULES also being there. One file, one read, one
// instant — the two conditions stay distinguishable no matter how torn the
// surrounding copy is:
//
//   marker present, rules present  -> a real, fully patched CMakeLists: proceed
//   marker absent,  rules absent   -> pristine or pre-bytecode-fixup: SKIP
//   marker present, rules absent   -> the fixup CALL is gone: FAIL, as before
//
// That last line is deliberate and load-bearing: skipping it would hide the
// reverted-call regression, which is the whole silent-drop shape one level up.
const CMAKE_POST_BYTECODE_MARKER = {
  text: '-Wl,--stack,8388608',
  fixup: 'fixupTjsCmakeWinStack',
};

// ONE read of CMakeLists.txt, judged once, and handed back so the assertion
// below judges THE SAME BYTES rather than re-reading a file that may have been
// rewritten in between. Returns { cmakeText, torn } where torn is a human
// sentence naming what it saw, or null when the copy is usable.
function inspectCopy(tjsDir) {
  const cmakeText = fs.readFileSync(path.join(tjsDir, 'CMakeLists.txt'), 'utf8');
  const missing = copyMissingSources(tjsDir, cmakeText);
  if (missing.length > 0) {
    return { cmakeText, torn: `missing ${missing.join(', ')}, which its own CMakeLists.txt `
      + 'references (window W1: the reset removed the patch-created sources and re-patching '
      + 'had not yet run)' };
  }
  if (!cmakeText.includes('CLODE_BYTECODE_RULES')
      && !cmakeText.includes(CMAKE_POST_BYTECODE_MARKER.text)) {
    return { cmakeText, torn: `its CMakeLists.txt carries neither the CLODE_BYTECODE_RULES `
      + `block nor ${CMAKE_POST_BYTECODE_MARKER.fixup}'s "${CMAKE_POST_BYTECODE_MARKER.text}" `
      + '(the fixup that edits this same file on the very next line), so this copy caught it '
      + 'pristine or before the bytecode fixup ran — window W2' };
  }
  return { cmakeText, torn: null };
}

// The lines cmake prints for each COMMENT "tjsc <path>" a rule actually ran — the direct
// observable of "which arrays did the graph decide needed rewriting", used below to prove
// both halves of the property: a genuine no-op touches NONE of them, and editing one .js
// touches EXACTLY its own .c and no other.
function tjscTouchedPaths(cmakeOutput) {
  return [...cmakeOutput.matchAll(/tjsc (\S+\.c)$/gm)].map((m) => m[1]);
}

test('a src/js/** edit changes its compiled src/bundles/c/** bytecode, via real cmake, with NO flag set', (t) => {
  // The minimal harness below assumes a single-config generator (Unix Makefiles/Ninja),
  // where `cmake --build <dir> --target tjsc` deposits the binary directly at <dir>/tjsc.
  // THIS harness passes no -G at all, so on win32 it would get cmake's DEFAULT generator
  // there — multi-config Visual Studio, which puts the binary at <dir>/Release/tjsc.exe.
  // That is the reason for the skip, and it is a property of this file, not of the
  // shipping build: build-tjs.cjs forces `-G Ninja -DCMAKE_C_COMPILER=cl` on the MSVC leg
  // (single-config) and looks for path.join(buildDir, 'tjsc.exe') with no Release/
  // handling anywhere. An earlier draft of this comment said the opposite — that the
  // shipping build uses a multi-config VS generator "which build-tjs.cjs handles" — which
  // was false in both halves and understated the real Windows exposure: the native MSVC
  // regen path (host tjsc -> -DCLODE_HOST_TJSC -> the injected rules) has never run on a
  // Windows leg at all. Windows coverage for the DEPENDS edge itself is
  // test/bytecode-rule.test.cjs's relative-input gate, the -D path normalization gate in
  // test/tjs-bytecode-regen.test.cjs, and the real matrix build; this specific end-to-end
  // run is POSIX-only.
  if (process.platform === 'win32') {
    t.skip('POSIX-only: this harness passes no -G, so on win32 it would get cmake\'s '
      + 'default multi-config Visual Studio generator, which deposits the binary at '
      + '<dir>/Release/tjsc.exe rather than the <dir>/tjsc this minimal reproduction of '
      + 'the bytecode target assumes. (The shipping Windows build does not go through '
      + 'here: build-tjs.cjs forces -G Ninja, a single-config generator.)');
    return;
  }
  const srcCheckout = path.join(tjsVendorParentDir(process.env), 'txiki.js');
  if (!fs.existsSync(path.join(srcCheckout, 'CMakeLists.txt'))) {
    t.skip(`no vendor checkout at ${srcCheckout} — run \`node scripts/build-tjs.cjs `
      + '--source-only\` once; this gate copies an existing checkout and will not clone '
      + '785MB inside a test run');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-bytecode-e2e-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const tjsDir = path.join(dir, 'txiki.js');
  copyCheckout(srcCheckout, tjsDir);

  // RETRY ONCE, THEN SKIP -- never fail on this (see inspectCopy's header for both
  // proven windows). resetCheckoutToPristine's reset+re-patch pass is short (low
  // single-digit seconds), so a fresh copy taken a moment later is very likely to land
  // outside it; if it is STILL torn after a retry, this is an environmental race against a
  // shared resource this test does not own, not a defect in the property under test, and a
  // skip that names the exact symptom is the honest result -- not a cmake error that names
  // neither the cause nor the remedy, not a reverted-call FAILURE in a tree where nothing
  // was reverted, and not silently tolerating a half-applied tree (the assertions below
  // are unchanged; only this precondition is re-established).
  let state = inspectCopy(tjsDir);
  if (state.torn) {
    fs.rmSync(tjsDir, { recursive: true, force: true });
    copyCheckout(srcCheckout, tjsDir);
    state = inspectCopy(tjsDir);
  }
  if (state.torn) {
    t.skip(`the copy of the shared vendor checkout at ${srcCheckout} is not a usable subject `
      + `-- checked twice, with a fresh copy in between: ${state.torn}. Either another test `
      + 'or a concurrent build was mid --source-only/resetCheckoutToPristine on the SAME '
      + 'shared checkout while this test copied it (that reset+re-patch pass is what opens '
      + 'both windows), or that checkout has never been through a source phase at all. '
      + 'Either way this is a precondition about a resource this test does not own, not a '
      + 'defect in the property under test; re-run once the shared checkout is quiescent '
      + '(`node scripts/build-tjs.cjs --source-only` leaves it fully patched).');
    return;
  }

  // The premise, checked as a FAILURE, not a skip -- and reachable only on bytes
  // inspectCopy has already established are NOT the pristine/pre-fixup shape, judged from
  // THE SAME string it read (state.cmakeText), never a second read of a file a concurrent
  // build may have rewritten since. A checkout existing is a test-infra precondition (skip
  // above); a pristine or pre-bytecode-fixup CMakeLists is the copy-time race (skip above);
  // but a CMakeLists carrying fixupTjsCmakeWinStack's marker -- written by the fixup that
  // edits this same file on the very next line after the bytecode one, from the very text
  // the bytecode fixup produced -- and still missing CLODE_BYTECODE_RULES can only mean the
  // fixup CALL was reverted, or the checkout predates it. That is exactly the pre-phase
  // defect this task exists to catch, so it FAILS. Skipping it instead would make the
  // reverted-call regression invisible; widening the skip to swallow it would have been the
  // easy wrong fix.
  assert.match(state.cmakeText, /CLODE_BYTECODE_RULES/,
    `${srcCheckout}/CMakeLists.txt carries no CLODE_BYTECODE_RULES block, although that same `
    + `file DOES carry ${CMAKE_POST_BYTECODE_MARKER.fixup}'s "${CMAKE_POST_BYTECODE_MARKER.text}" `
    + '-- and that fixup runs on the very next line after the bytecode one, over the text the '
    + 'bytecode fixup just wrote. So this is NOT the copy-time race: either the '
    + 'fixupTjsCmakeBytecodeRules CALL (scripts/build-tjs.cjs source phase) was reverted, or '
    + 'the shared checkout predates it. Re-run `node scripts/build-tjs.cjs --source-only` to '
    + 'refresh it.');

  // CAPPED, not os.cpus().length (fix round 1, general hygiene -- NOT the fix for the
  // torn-copy flake above, which is a shared-checkout race, not compile contention; job
  // count cannot make a file disappear). test/run.mjs invokes `node --test` with no
  // --test-concurrency override, so test FILES already run concurrently across worker
  // processes; this is also the first file in the suite that drives a real, native
  // compiler+linker build (build-tjs-no-node.test.cjs only runs --source-only,
  // tjs-bytecode-regen.test.cjs only touches synthetic fixtures). A full core count here
  // would be oversubscription by construction -- N of these plus every OTHER test file's
  // own work, all competing for the same physical cores at once. 2 is a small, fixed
  // budget: enough that the one-time qjs+tjsc compile below is not fully serial, small
  // enough that it does not itself add a second contention surface on top of the real one.
  const jobs = '2';
  // TIMEOUT, not open-ended (fix round 1, same hygiene): a STALL under contention (vs. an
  // ordinary slow compile) must fail with a message, not hang the whole suite silently.
  // 300s is generous even at -j2 for a cold qjs+tjsc compile (measured ~20s unloaded) with
  // headroom for a busy box; execFileSync throws ETIMEDOUT (SIGTERM to the child) past it.
  const CMD_TIMEOUT_MS = 300000;
  const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: CMD_TIMEOUT_MS, ...opts });
  const buildHostTjsc = loadBuildHostTjsc(run, jobs);

  const hostBuildDir = path.join(dir, 'build-host-tjsc');
  const tjsc = buildHostTjsc(tjsDir, hostBuildDir, 'test/tjs-bytecode-e2e.test.cjs proving the DEPENDS edge');

  // A SECOND configure of the SAME build dir buildHostTjsc just produced -- not a fresh
  // -B -- so this is the identical if(CLODE_HOST_TJSC)-guarded mechanism a real
  // build-tjs.cjs run drives, not a parallel path this test invented.
  run('cmake', ['-S', tjsDir, '-B', hostBuildDir, `-DCLODE_HOST_TJSC=${tjsc}`]);

  const targetC = path.join(tjsDir, 'src/bundles/c/internal/path.c');

  // PRIME: the first build after a configure that just now started passing CLODE_HOST_TJSC
  // regenerates every array unconditionally (cmake has no prior record that these
  // committed, git-checked-out .c files already satisfy their .js DEPENDS -- a property of
  // this being the first build against this build dir, not of the mechanism itself; the
  // "how many touched" property below is asserted on the SECOND build instead, once cmake
  // has a real timestamp baseline).
  run('cmake', ['--build', hostBuildDir, '--target', 'clode_bytecode', '-j', jobs]);
  const primedHash = sha256(targetC);

  // A genuine no-op rebuild: nothing under src/js/** or src/bundles/js/** changed since
  // the prime build above. Zero tjsc invocations is the per-file property that
  // distinguishes a real dependency graph from blind regeneration -- verified by hand in
  // this task's by-hand demonstration and asserted here so it stays true.
  const noopOut = run('cmake', ['--build', hostBuildDir, '--target', 'clode_bytecode', '-j', jobs]);
  assert.deepStrictEqual(tjscTouchedPaths(noopOut), [],
    `a no-op rebuild re-ran tjsc on something (${JSON.stringify(tjscTouchedPaths(noopOut))}) -- `
    + 'the rule must be per-file, driven by real DEPENDS timestamps, not a blind regeneration');
  assert.strictEqual(sha256(targetC), primedHash, 'a no-op rebuild must not change the bytes');

  // THE ACCEPTANCE: edit a real src/js/** input directly, no --source-only, no esbuild
  // step in between. internal/path.js is one of the two bundles bytecodeBundlePairs()
  // hands tjsc straight from src/js/** rather than from an esbuilt src/bundles/js/**
  // intermediate (bytecodeBundlePairs: { outC: 'src/bundles/c/internal/path.c', inJs:
  // 'src/js/internal/path.js' }), so this is the smallest edit that reaches the compiled
  // .c with no intervening build step this test would otherwise have to run too.
  const inJs = path.join(tjsDir, 'src/js/internal/path.js');
  const probe = `task3-e2e-${process.pid}-${Date.now()}`;
  fs.appendFileSync(inJs, `\nglobalThis.__task3BytecodeProbe = ${JSON.stringify(probe)};\n`);

  // No CLODE_TJS_REGEN read, set, or mentioned above this line, or below it. That absence
  // IS the acceptance: the pre-phase defect was that regeneration needed an opt-in nobody
  // set; this rebuild regenerates because the graph says the .c is now older than its .js,
  // full stop.
  const editOut = run('cmake', ['--build', hostBuildDir, '--target', 'clode_bytecode', '-j', jobs]);
  assert.deepStrictEqual(tjscTouchedPaths(editOut), ['src/bundles/c/internal/path.c'],
    `editing src/js/internal/path.js should re-run tjsc on exactly its own array, got `
    + `${JSON.stringify(tjscTouchedPaths(editOut))}`);

  const editedHash = sha256(targetC);
  assert.notStrictEqual(editedHash, primedHash,
    `editing ${inJs} did not change ${targetC} -- this is the exact silent drop phase `
    + '4c-2 exists to end (a correct AbortSignal.timeout patch built clean and changed '
    + 'nothing), reproduced here with no CLODE_TJS_REGEN set anywhere in this process');

  console.log(`tjs-bytecode-e2e: src/bundles/c/internal/path.c ${primedHash.slice(0, 12)} -> ${editedHash.slice(0, 12)}`);
});

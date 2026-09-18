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
// NO CLODE_TJS_REGEN, ANYWHERE IN THIS FILE — read that as load-bearing, not incidental.
// This test never execs scripts/build-tjs.cjs and never even names that variable: cmake is
// driven directly, with the two commands a real build's regenerating branch issues
// (buildHostTjsc, then a second configure with -DCLODE_HOST_TJSC). That is a STRICTER form
// of "no flag set" than running build-tjs.cjs with an unset env var would be — there is no
// flag-reading code in the path at all for one to accidentally reintroduce.
//
// COST, stated because this is now a known-expensive member of the default suite: roughly
// 60-90s wall clock, measured (a cold qjs+tjsc compile, capped at 2 parallel jobs — see
// the `jobs` comment below for why not more), and it is the ONLY file in test/ that drives
// a real native compiler+linker build rather than text/fixture assertions. Not gated
// behind an opt-in: the cost is bounded by the existing warm-checkout skip (nothing to
// build without one), and the property it proves does not exist anywhere else in the
// suite.
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
// copyCheckout runs — proven, not guessed, by a reproduced 3-run flake (see
// copyMissingSources' header below for the mechanism). An occasional SKIP naming a missing
// source file under this test is that race, caught and reported honestly; it is the first
// place to look, not a mystery.
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
function copyMissingSources(tjsDir) {
  const cmakeText = fs.readFileSync(path.join(tjsDir, 'CMakeLists.txt'), 'utf8');
  // The exact shape that broke: a bare `src/....c` source-list line inside
  // add_library(tjs STATIC ...)/add_executable(tjsc ...). Deliberately narrow (not every
  // path CMakeLists.txt could ever mention) — this is a targeted symptom check for the
  // proven failure mode, not a general build-graph validator.
  const listed = [...cmakeText.matchAll(/^ {4}(src\/[\w./-]+\.c)$/gm)].map((m) => m[1]);
  return listed.filter((f) => !fs.existsSync(path.join(tjsDir, f)));
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
  // where `cmake --build <dir> --target tjsc` deposits the binary directly at
  // <dir>/tjsc. Windows' default generator (multi-config Visual Studio) and the MSVC path
  // build-tjs.cjs actually selects for it put the binary at <dir>/Release/tjsc.exe
  // instead — real complexity build-tjs.cjs earns for the shipping build, which this
  // minimal reproduction of just the bytecode target does not carry. Recorded honestly:
  // Windows coverage for the DEPENDS edge itself is test/bytecode-rule.test.cjs's
  // relative-input gate plus the real matrix build; this specific end-to-end run is
  // POSIX-only.
  if (process.platform === 'win32') {
    t.skip('POSIX-only: this harness assumes a single-config generator (cmake --build '
      + '--target tjsc -> <dir>/tjsc); MSVC\'s default multi-config generator puts it at '
      + '<dir>/Release/tjsc.exe instead, which build-tjs.cjs handles for the real build '
      + 'and this minimal reproduction of only the bytecode target does not');
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

  // RETRY ONCE, THEN SKIP -- never fail on this (see copyMissingSources' header for the
  // proven mechanism). resetCheckoutToPristine's reset+re-patch window is short (low
  // single-digit seconds), so a fresh copy taken a moment later is very likely to land
  // outside it; if it is STILL torn after a retry, this is an environmental race against a
  // shared resource this test does not own, not a defect in the property under test, and a
  // skip that names the exact missing file is the honest result -- not a cmake error that
  // names neither the cause nor the remedy, and not silently tolerating a missing file
  // (the assertions below are unchanged; only this precondition is re-established).
  let missing = copyMissingSources(tjsDir);
  if (missing.length > 0) {
    fs.rmSync(tjsDir, { recursive: true, force: true });
    copyCheckout(srcCheckout, tjsDir);
    missing = copyMissingSources(tjsDir);
  }
  if (missing.length > 0) {
    t.skip(`the shared vendor checkout at ${srcCheckout} was being rewritten while this `
      + `test copied it, twice in a row (missing ${missing.join(', ')}, which its own `
      + 'CMakeLists.txt references) -- another test or a concurrent build was mid '
      + '--source-only/resetCheckoutToPristine on the SAME shared checkout. This is an '
      + 'environmental race against a resource this test does not own, not a defect in '
      + 'the property under test; re-run once the shared checkout is quiescent.');
    return;
  }

  // The premise, checked as a FAILURE, not a skip. A checkout existing is a test-infra
  // precondition (skip above); a checkout that exists but carries no CLODE_BYTECODE_RULES
  // block is exactly the pre-phase defect this task exists to catch — the fixup call
  // (scripts/build-tjs.cjs, source phase) never ran over it, or was reverted. Skipping
  // here instead of failing would make the reverted-call regression invisible, which is
  // the whole silent-drop shape one level up.
  assert.match(fs.readFileSync(path.join(tjsDir, 'CMakeLists.txt'), 'utf8'), /CLODE_BYTECODE_RULES/,
    `${srcCheckout}/CMakeLists.txt carries no CLODE_BYTECODE_RULES block -- either the `
    + 'fixupTjsCmakeBytecodeRules CALL (scripts/build-tjs.cjs source phase) was reverted, '
    + 'or the shared checkout predates it. Re-run `node scripts/build-tjs.cjs '
    + '--source-only` to refresh it.');

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

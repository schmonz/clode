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
// COPY, NEVER MUTATE THE SHARED CHECKOUT. ~/.cache/clode/tjs-vendor/txiki.js (or wherever
// CLODE_TJS_VENDOR points) is the ONE checkout every build on this box patches/resets/
// re-patches from; a test that edited its src/js/** directly would corrupt every later
// build. test/build-tjs-no-node.test.cjs solved this first — CoW-copy into a mkdtemp, then
// operate on the copy alone — and copyCheckout below is that same approach, not a fresh
// design.
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

  const jobs = String(Math.max(1, os.cpus().length));
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
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

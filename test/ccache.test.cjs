'use strict';
// scripts/ccache-launcher.cjs — spec 4c3 task 1 ("wire it, optionally") and task 2
// ("prove it helps, and prove it does not lie"). The property that matters most for
// task 1's half is the NEGATIVE one: a leg that has never heard of the tool must build
// EXACTLY as it did before this file existed — proven below against a PATH built to
// exclude ccache (this box has a real one installed for task 2, so that proof can no
// longer lean on ambient state; see the comment at that test for the history).
//
// This file imports the module under test directly rather than reading
// scripts/build-tjs.cjs as text — that file runs a real engine build top to bottom the
// moment it is required, so nothing here can afford to require() it. The two exported
// functions are the entire seam scripts/build-tjs.cjs uses; testing them by direct call
// is testing the real behavior, not a reimplementation of it.
const { test } = require('node:test');
const assert = require('node:assert');
const { ccacheLauncher, applyCcacheArg, ccacheOptedOut } = require('../scripts/ccache-launcher.cjs');
const { findTool } = require('../libexec/clode-hosttools.cjs');
// Task 2's own requires -- a real build, a real cache, a real diff. Nothing above this
// line needed any of these; nothing below the PROOF tests should need anything else.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const repo = path.join(__dirname, '..');

// A fixed base array, standing in for whatever scripts/build-tjs.cjs's own cmakeArgs
// looked like the moment before this feature's one call site was added. Every "byte-
// identical" assertion below compares against a fresh copy of this same array.
const BASE_ARGS = Object.freeze(['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF']);

// ---- the absent path, proven against a PATH built to exclude ccache, not a mock ---
//
// This USED to call the real findTool with no env override at all, trusting that this
// box's ambient PATH genuinely had no ccache on it — true when task 1 shipped, and this
// file's own comment already named the day it would stop being true: "if this ever
// starts failing because someone installed it, the absent-path test below needs a PATH
// override instead of relying on ambient state." Task 2 is that day (pkgsrc: `pkg_add
// ccache`, so this box now has one at /opt/pkg/bin/ccache) — so the tests below build a
// PATH that excludes it explicitly, verified empty first, rather than hoping the ambient
// one stays clean.
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

test('a PATH built to exclude ccache resolves none (so the next test is real, not a fluke)', () => {
  assert.strictEqual(findTool('ccache', { env: { PATH: BARE_PATH } }), null,
    `${BARE_PATH} unexpectedly resolved a ccache — the absent-path test below needs a `
    + 'PATH that genuinely excludes it, and this one no longer does');
});

test('absent: cmakeArgs comes out byte-identical to before this feature existed', () => {
  const launcherPath = ccacheLauncher({ env: { PATH: BARE_PATH }, findToolFn: findTool });
  assert.strictEqual(launcherPath, null,
    'findTool must report ccache absent on a PATH built to exclude it');
  const out = applyCcacheArg([...BASE_ARGS], launcherPath);
  assert.deepStrictEqual(out, BASE_ARGS,
    'a leg with no ccache must see the exact same cmakeArgs it saw before this feature '
    + 'shipped — no new entry, no reordering');
});

test('opt-out: CLODE_TJS_CCACHE=0 suppresses the probe even when a launcher would resolve', () => {
  const fakeFindToolFn = () => '/fake/bin/ccache';
  const path = ccacheLauncher({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, null, 'the opt-out must win over a resolvable launcher');
});

// ---- the opt-out has to reach CMAKE, not just this function ------------------------
//
// THE BUG THIS PINS (found in review, 2026-09-19): `CLODE_TJS_CCACHE=0` was implemented as
// "push no flag", which is correct for a build dir cmake has never configured and a NO-OP
// for one it has. cmake PERSISTS `-D` values in CMakeCache.txt, and scripts/build-tjs.cjs
// deliberately REUSES build dirs across runs (dropStaleCmakeCache only wipes when the
// source dir moved). So the exact scenario the opt-out exists for -- "I suspect the cache,
// turn it off and rebuild" -- silently kept using ccache, forever, on every developer box
// that had ever built once with it. Nothing caught it because the e2e gate wipes buildRoot
// at the top of every phase, which is right for isolating the phases and is precisely what
// hides this.
//
// THE FIX IS ASYMMETRIC, AND THE ASYMMETRY IS THE POINT. Clearing unconditionally would
// break task 1's headline negative property (a leg with no ccache must produce cmake args
// byte-identical to the pre-feature ones). So the empty `-D` rides the EXPLICIT OPT-OUT
// branch only -- never the tool-absent branch. Both halves are asserted below.
test('opt-out: the launcher is explicitly CLEARED, not merely left unset', () => {
  const out = applyCcacheArg([...BASE_ARGS], null, { optedOut: true });
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER='],
    'CLODE_TJS_CCACHE=0 must push an EMPTY -DCMAKE_C_COMPILER_LAUNCHER: pushing nothing is a '
    + 'no-op against a build dir whose CMakeCache already carries the launcher');
});

test('absent: the tool-absent branch does NOT clear (task 1\'s negative property survives the fix)', () => {
  assert.deepStrictEqual(applyCcacheArg([...BASE_ARGS], null, { optedOut: false }), BASE_ARGS,
    'a leg that simply has no ccache must still see byte-identical cmake args -- only an '
    + 'EXPLICIT opt-out may add a clearing flag');
  assert.deepStrictEqual(applyCcacheArg([...BASE_ARGS], null), BASE_ARGS,
    'the default (no options object) is the absent case, not the opted-out one');
});

test('ccacheOptedOut reads exactly CLODE_TJS_CCACHE=0, and is what the call site must pass', () => {
  assert.strictEqual(ccacheOptedOut({ CLODE_TJS_CCACHE: '0' }), true);
  assert.strictEqual(ccacheOptedOut({ CLODE_TJS_CCACHE: '1' }), false);
  assert.strictEqual(ccacheOptedOut({}), false);
  // The wiring: build-tjs.cjs must hand applyCcacheArg BOTH halves. Asserted as text
  // because requiring that file runs a whole engine build (see this file's header).
  const src = fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8');
  assert.match(src, /applyCcacheArg\(cmakeArgs, ccacheLauncher\(\), \{ optedOut: ccacheOptedOut\(\) \}\)/,
    'scripts/build-tjs.cjs must pass the opt-out decision through, or the clearing flag '
    + 'never reaches a real cmake reconfigure');
});

// The property at the grain it actually bites: a REAL cmake build dir, already configured
// WITH the launcher, reconfigured through the opt-out's own argument list. This is the test
// that was missing; a unit test over applyCcacheArg alone cannot see a CMakeCache.
test('opt-out: a build dir already configured WITH ccache stops using it after a reconfigure', (t) => {
  const cmake = findTool('cmake');
  if (!cmake) { t.skip('no cmake on PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccache-optout-cmake-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const src = path.join(dir, 'src');
  const bld = path.join(dir, 'b');
  fs.mkdirSync(src);
  // NONE: no compiler probe, so this stays fast and platform-independent. The variable is
  // a plain cache entry either way -- persistence is a cmake-cache property, not a
  // language-enablement one.
  fs.writeFileSync(path.join(src, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.10)\nproject(ccache_optout NONE)\n');
  const configure = (args) => {
    const r = spawnSync(cmake, ['-S', src, '-B', bld, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `cmake failed: ${r.stdout}\n${r.stderr}`);
  };
  const cached = () => {
    const line = fs.readFileSync(path.join(bld, 'CMakeCache.txt'), 'utf8').split('\n')
      .find((l) => l.startsWith('CMAKE_C_COMPILER_LAUNCHER:'));
    return line === undefined ? null : line.slice(line.indexOf('=') + 1);
  };

  // 1. the normal state of every build dir on a box with ccache: configured WITH it.
  configure(applyCcacheArg([], '/fake/bin/ccache', { optedOut: false }));
  assert.strictEqual(cached(), '/fake/bin/ccache', 'setup: the launcher should be cached here');

  // 2. now the user sets CLODE_TJS_CCACHE=0 and rebuilds. build-tjs.cjs reuses this build
  //    dir, so THIS is the argument list cmake gets.
  const optedOutArgs = applyCcacheArg([], ccacheLauncher({
    env: { CLODE_TJS_CCACHE: '0', PATH: process.env.PATH }, findToolFn: findTool,
  }), { optedOut: ccacheOptedOut({ CLODE_TJS_CCACHE: '0' }) });
  configure(optedOutArgs);
  assert.strictEqual(cached(), '',
    'CLODE_TJS_CCACHE=0 left the launcher in CMakeCache.txt -- the documented opt-out does '
    + 'nothing on a build dir that was already configured with ccache, which is every build '
    + 'dir on a box that has built once');
});

// ---- the present path, exercised through the injection seam, not a real install ----
//
// WHAT THIS PROVES: given a launcher path, the flag lands, with the right value, exactly
// once. WHAT THIS DOES NOT PROVE: that a REAL ccache binary at that path behaves as a
// correct cmake compiler launcher, or that its cache is keyed safely across a cross leg
// or the tjsc regen path — that is task 2's job, against a real install. This only
// proves scripts/build-tjs.cjs's OWN detect-and-push wiring is correct once something is
// found; the finding itself is faked here on purpose, since this box has nothing to find.

test('present: an injected launcher lands as -DCMAKE_C_COMPILER_LAUNCHER exactly once', () => {
  const fakeFindToolFn = (name) => (name === 'ccache' ? '/fake/bin/ccache' : null);
  const path = ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn });
  assert.strictEqual(path, '/fake/bin/ccache');
  const out = applyCcacheArg([...BASE_ARGS], path);
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.strictEqual(hits.length, 1, `expected exactly one launcher flag, got: ${out.join(' ')}`);
  assert.deepStrictEqual(out, [...BASE_ARGS, '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache']);
});

test('the injection seam is really being used: a name other than ccache resolves to nothing', () => {
  const fakeFindToolFn = (name) => (name === 'some-other-tool' ? '/fake/bin/other' : null);
  assert.strictEqual(ccacheLauncher({ env: {}, findToolFn: fakeFindToolFn }), null,
    'ccacheLauncher must ask findToolFn for "ccache" specifically, not accept anything found');
});

// ---- red proofs: each assertion above actually catches the broken version it exists ----
// ---- to catch, exercised against a deliberately wrong stand-in for the real function ----

test('PROOF: the absent-path assertion fails against a launcher that always pushes', () => {
  const alwaysPush = (cmakeArgs) => { cmakeArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=/oops'); return cmakeArgs; };
  assert.throws(() => {
    assert.deepStrictEqual(alwaysPush([...BASE_ARGS]), BASE_ARGS);
  }, 'a broken always-push implementation must fail the byte-identical check, or that check is worthless');
});

test('PROOF: the opt-out assertion fails against a launcher that ignores CLODE_TJS_CCACHE=0', () => {
  const ignoresOptOut = ({ findToolFn }) => findToolFn('ccache');
  const fakeFindToolFn = () => '/fake/bin/ccache';
  assert.throws(() => {
    assert.strictEqual(ignoresOptOut({ env: { CLODE_TJS_CCACHE: '0' }, findToolFn: fakeFindToolFn }), null);
  }, 'an implementation that never reads CLODE_TJS_CCACHE must fail the opt-out check');
});

test('PROOF: the present-path exactly-once assertion fails against a launcher pushed twice', () => {
  const pushesTwice = (cmakeArgs, path) => {
    if (path) { cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); cmakeArgs.push(`-DCMAKE_C_COMPILER_LAUNCHER=${path}`); }
    return cmakeArgs;
  };
  const out = pushesTwice([...BASE_ARGS], '/fake/bin/ccache');
  const hits = out.filter((a) => a === '-DCMAKE_C_COMPILER_LAUNCHER=/fake/bin/ccache');
  assert.throws(() => {
    assert.strictEqual(hits.length, 1);
  }, 'a double-push must fail the exactly-once check');
});

// ============================================================================================
// Task 2 -- a REAL ccache, proving it does not lie (spec 4c3 acceptance 7's second half).
// Every test above this line exercises the launcher wiring through a synthetic findToolFn,
// because no real ccache existed on this box when task 1 shipped. It does now (installed via
// pkgsrc: `pkg_add ccache`, landing at /opt/pkg/bin/ccache, package ccache-4.13.6 -- see
// BACKLOG.md for the how/why this test does not repeat).
//
// THE STAKE: ccache keys its cache on the compiler invocation it can observe (compiler path,
// flags, preprocessed source). This project cross-builds 17 of its 42 legs from one host and
// regenerates bytecode through a SEPARATE host-native tjsc on that same box (phases 4c-2 /
// 4c-2b) -- a mis-keyed hit in either shape hands a build the WRONG object, silently, exit 0,
// shipped. A timing win that cannot also prove this did not happen is not worth having.
//
// THE DIFFERENTIAL IS THE AUDIT, not a one-time measurement: ccache's cache key is opaque from
// the outside -- unlike scripts/engine-recipe.mjs's hash, there is no second list to compare it
// against -- so the only way to know it stayed sound as sources and targets change is to keep
// re-deriving the answer by actually building. That is exactly what both of engine-recipe.mjs's
// own scars were missing: the cosmo patches absent from that recipe's key "cost 13 commits of
// red ... the recipe hash did not move, so nothing said the engine sources had changed", and the
// netbsd-sparc bake recipe where "an edit to it moved nothing, so the tjs cache happily restored
// an engine built by a DIFFERENT recipe." Both scars are a cache whose key silently stopped
// covering an input. This test is the standing gate against ccache doing the same thing --
// gated behind an opt-in (below) because it drives three real engine builds, not because the
// property it proves is optional.
//
// SCOPE, stated plainly so a green run here is never read as more than it is: this exercises
// the HOST leg alone, whatever platform `node --test` happens to run on. The 17 cross legs and
// the two Windows hard publishers are NOT proven by this file -- that is CI's job, on CI's own
// hosts, with CI's own compilers and CI's own object layout. A pass here says "ccache did not
// corrupt THIS host's native compile"; it says nothing about a cross toolchain's flags landing
// in a differently-shaped ccache key, which is precisely the mis-keying this whole task exists
// to rule out fleet-wide, not just on one box.
//
// THE FIRST THING THIS TEST HAD TO PROVE WAS ITS OWN INSTRUMENT -- found empirically, not
// assumed (the "instruments lie, check them first" discipline). The obvious design is: build
// the engine with the cache off, hash the linked binary; build again with the cache warm, hash
// it; compare. That design is WRONG on this host, independently of ccache. Two builds run back
// to back with CLODE_TJS_CCACHE=0 BOTH times -- same vendor checkout, same outDir, same
// buildDir -- produced two DIFFERENT sha256 sums for the linked engine. Root-caused byte for
// byte rather than shrugged at:
//   1. the linked Mach-O carries an LC_UUID load command Apple's linker assigns FRESH on every
//      link (`otool -l` showed two different UUIDs from the same two builds) -- 16 bytes of
//      pure metadata, never derived from source content, and nothing ccache touches;
//   2. stripping the debug symbol table (which is where those 16 bytes' knock-on cost lives --
//      an embedded per-object-file modification time re-hashed into the trailing ad-hoc code
//      signature) dropped a 651-byte "diff" to 17: 16 were the UUID above, and the surviving
//      ONE byte traced (via a raw offset dump, not a guess) to deps/mimalloc/src/options.c:239,
//      which prints a build banner using two macros that mean "evaluate me fresh on every
//      compile". mimalloc's own object -- and, checked directly below, ONLY mimalloc's -- is
//      therefore expected to differ between any two compiles of this engine, on this host,
//      forever, cache or no cache.
// Neither cause is ccache's. Both are proven present with ccache completely disabled. So the
// correctness question this task actually owes an answer to -- did ccache ever serve the WRONG
// bytes for a compilation it claims matched -- has to be asked at the grain ccache actually
// operates on: one compiled object per translation unit, not the final link (which layers a
// random UUID and a re-hashed signature on top, turning a real 1-byte content difference into
// hundreds of bytes of noise that have nothing to do with caching). OBJECTS_EXPECTED_VOLATILE
// below names the one object already PROVEN (not assumed) to vary for reasons that predate this
// task; every OTHER object compiled for the engine is compared byte for byte across all three
// runs, and THAT comparison -- not a whole-binary hash -- is this test's real verdict. The
// linked engine's own hash is still taken and logged for every phase (in case a future
// divergence widens beyond the two named causes), but it is deliberately not asserted equal:
// doing so would make this gate flaky for a reason that has nothing to do with the property it
// exists to prove, which teaches whoever hits the flake to stop trusting it or to bypass it --
// the opposite of what a gate is for.
//
// A second entry here is not expected to appear casually: it would mean a second source file
// whose compiled bytes vary for reasons unrelated to caching, which deserves its own
// investigation before being excused, not a quiet allowlist reached for under time pressure.
const OBJECTS_EXPECTED_VOLATILE = [
  {
    rel: 'deps/mimalloc/CMakeFiles/mimalloc-static.dir/src/options.c.o',
    because: 'deps/mimalloc/src/options.c:239 prints a build banner via `__DATE__, __TIME__` '
      + '-- macros the preprocessor evaluates fresh on every invocation, so this object '
      + 'legitimately differs on every compile regardless of caching. Corroborated, not just '
      + "asserted: it is also the SOLE cache miss ccache's own stats report on an otherwise "
      + 'fully warm rebuild -- ccache is not lying about this one, it is correctly declining '
      + 'to trust a translation unit that names itself unstable.',
  },
];

function why() {
  if (process.env.CLODE_CCACHE_ENGINE_E2E !== '1') {
    return 'opt-in: set CLODE_CCACHE_ENGINE_E2E=1 (three real engine builds, several minutes)';
  }
  if (process.platform === 'win32') {
    return 'host-only for now: the object-identity harness below has not been proven against '
      + "the MSVC leg's .obj layout or its generator -- see the file header's SCOPE note";
  }
  if (findTool('ccache') === null) {
    return 'no ccache on PATH -- install it (pkgsrc: `pkg_add ccache`) to exercise this gate';
  }
  const checkout = path.join(tjsVendorParentDir(process.env), 'txiki.js');
  if (!fs.existsSync(path.join(checkout, 'CMakeLists.txt'))) {
    return `no vendor checkout at ${checkout} -- run \`node scripts/build-tjs.cjs `
      + '--source-only` once first; this gate copies an existing checkout and will not clone '
      + '785MB inside a test run';
  }
  return null;
}

// A throwaway copy-on-write copy of an EXISTING vendor checkout, never the shared one --
// the same recipe test/tjs-bytecode-e2e.test.cjs and test/build-tjs-no-node.test.cjs already
// use, not a fresh design. build-tjs.cjs resets ITS OWN patched tree to pristine on every
// run, so mutating the shared ~/.cache/clode/tjs-vendor checkout with three back-to-back
// full builds would leave every OTHER build on this box patching from a tree this test
// disturbed mid-flight.
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

// The one place this file names the SHIPPED build dir's shape: buildRoot is what this test
// hands build-tjs.cjs as its build-dir override, but the script nests the REAL cmake build
// dir one level down (a per-target hash it derives from outDir, so a shared tree never lets
// two targets collide -- see build-tjs.cjs's targetToken()). Rather than reimplement that
// hash here (a second copy of a naming scheme is exactly how the netbsd-sparc bake drifted),
// find the one CMakeCache.txt whose PARENT is literally named `build` -- the main engine
// target, never build-tjs.cjs's separate build-depscan tool dir alongside it.
function findBuildDir(buildRoot) {
  const found = spawnSync('find', [buildRoot, '-name', 'CMakeCache.txt'], { encoding: 'utf8' });
  assert.strictEqual(found.status, 0, `find over ${buildRoot} failed: ${found.stderr}`);
  const hits = found.stdout.split('\n').filter(Boolean)
    .filter((p) => path.basename(path.dirname(p)) === 'build');
  assert.strictEqual(hits.length, 1,
    `expected exactly one main-engine CMakeCache.txt under ${buildRoot}, found: `
    + `${JSON.stringify(hits)}`);
  return path.dirname(hits[0]);
}

// Every compiled translation unit under a build dir, repo-relative to IT (not to the repo),
// so the same relative name lines up across three independently rooted build dirs. Shells
// out to `find` rather than walking the tree in-process -- this project's C build produces a
// few hundred of these per phase, and a plain recursive listing is the same handful of bytes
// either way.
function listObjects(buildDir) {
  const found = spawnSync('find', [buildDir, '-name', '*.c.o'], { encoding: 'utf8' });
  assert.strictEqual(found.status, 0, `find over ${buildDir} failed: ${found.stderr}`);
  return found.stdout.split('\n').filter(Boolean)
    .map((abs) => path.relative(buildDir, abs).split(path.sep).join('/'))
    .sort();
}

// Streamed, not loaded whole -- these objects are small, but the habit is the point: this
// file never pulls a build artifact into memory in one shot.
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Copies everything THIS phase's identity check and diagnostics need out of the shared
// buildRoot/outDir before the next phase wipes and overwrites both -- the reason this exists
// at all is that outDir and buildRoot are deliberately the SAME path across all three phases
// (see the test body for why), so nothing about them survives past the next runPhase() call
// unless it is copied out first.
function snapshotPhase(label, buildDir, outBin, snapshotsRoot) {
  const objDir = path.join(snapshotsRoot, label, 'objs');
  fs.mkdirSync(objDir, { recursive: true });
  const objects = listObjects(buildDir);
  for (const rel of objects) {
    const dest = path.join(objDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(buildDir, rel), dest);
  }
  const enginePath = path.join(snapshotsRoot, label, 'tjs');
  fs.copyFileSync(outBin, enginePath);
  return { label, objects, objDir, enginePath };
}

function parseCcacheStats(text) {
  const hits = text.match(/^\s*Hits:\s*(\d+)\s*\/\s*(\d+)/m);
  const misses = text.match(/^\s*Misses:\s*(\d+)\s*\/\s*(\d+)/m);
  assert.ok(hits && misses, `could not parse ccache --show-stats output:\n${text}`);
  return { hits: Number(hits[1]), calls: Number(hits[2]), misses: Number(misses[1]) };
}

test('a real, warm ccache serves byte-identical objects for a full engine build (host leg only)', async (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }
  const ccachePath = findTool('ccache');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccache-engine-e2e-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const vendorParent = path.join(dir, 'vendor');
  fs.mkdirSync(vendorParent, { recursive: true });
  copyCheckout(path.join(tjsVendorParentDir(process.env), 'txiki.js'), path.join(vendorParent, 'txiki.js'));

  // outDir and buildRoot are FIXED across all three phases -- deliberately, not an oversight.
  // Two builds into two DIFFERENT outDir paths embed that path's own string into their
  // objects (this project's C sources use __FILE__-style absolute paths in a few places),
  // which would show up as a "difference" that is really just two builds disagreeing about
  // where they were told to live. Holding both paths constant and wiping buildRoot between
  // phases (below) isolates the one variable this test is actually about: whether the cache
  // was on, and whether it was warm.
  const outDir = path.join(dir, 'out');
  const buildRoot = path.join(dir, 'build-root');
  const ccacheDir = path.join(dir, 'ccache-dir');
  const snapshotsRoot = path.join(dir, 'snapshots');
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: vendorParent,
    CLODE_TJS_OUT: outDir,
    CLODE_TJS_BUILD: buildRoot,
  };
  const BUILD_TIMEOUT_MS = 6 * 60 * 1000;

  const runPhase = (label, extraEnv) => {
    fs.rmSync(buildRoot, { recursive: true, force: true });
    const startedAt = Date.now();
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts/build-tjs.cjs')],
      { cwd: repo, env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS });
    const wallMs = Date.now() - startedAt;
    assert.strictEqual(r.status, 0, `${label} engine build failed:\n${r.stdout}\n${r.stderr}`);
    // Status alone is not enough (build-tjs.cjs's own header explains why: under tjs an
    // unhandled rejection can be swallowed outright). This runs under real Node, not the
    // shim, but the marker check is free and it is the same discipline
    // test/build-tjs-no-node.test.cjs already applies for the same reason.
    assert.match(r.stdout, /\(tjs-shim-ok\)/,
      `${label} build exited 0 without its success marker:\n${r.stdout}`);
    const buildDir = findBuildDir(buildRoot);
    const snap = snapshotPhase(label, buildDir, path.join(outDir, 'tjs'), snapshotsRoot);
    return { label, wallMs, ...snap };
  };

  // PHASE 1: no launcher at all -- today's behavior on every leg that has never heard of
  // ccache, and the reference every other phase below is judged against.
  const off = runPhase('off', { CLODE_TJS_CCACHE: '0' });

  // PHASE 2: the launcher wired, cache EMPTY -- every cacheable call must miss.
  fs.rmSync(ccacheDir, { recursive: true, force: true });
  fs.mkdirSync(ccacheDir, { recursive: true });
  spawnSync(ccachePath, ['--zero-stats'], { env: { ...baseEnv, CCACHE_DIR: ccacheDir } });
  const onCold = runPhase('on-cold', { CCACHE_DIR: ccacheDir });
  const statsCold = spawnSync(ccachePath, ['--show-stats', '-v'],
    { env: { ...baseEnv, CCACHE_DIR: ccacheDir }, encoding: 'utf8' }).stdout;

  // PHASE 3: the SAME cache, now warm -- an unchanged rebuild, the literal acceptance.
  // Zeroed again: ccache's stats are CUMULATIVE across invocations sharing a CCACHE_DIR, so
  // without this the warm phase's own numbers would be buried under phase 2's 371 misses
  // (caught exactly this way, not hypothesized -- the first run of this test reported "742
  // cacheable calls" and 372 misses before this line existed).
  spawnSync(ccachePath, ['--zero-stats'], { env: { ...baseEnv, CCACHE_DIR: ccacheDir } });
  const onWarm = runPhase('on-warm', { CCACHE_DIR: ccacheDir });
  const statsWarm = spawnSync(ccachePath, ['--show-stats', '-v'],
    { env: { ...baseEnv, CCACHE_DIR: ccacheDir }, encoding: 'utf8' }).stdout;

  // THE HEADLINE ASSERTION. Same set of objects compiled every time, or something about the
  // build graph itself changed between phases and nothing below this line means anything.
  assert.deepStrictEqual(onCold.objects, off.objects,
    'ccache ON compiled a DIFFERENT set of objects than ccache OFF');
  assert.deepStrictEqual(onWarm.objects, off.objects,
    'the warm rebuild compiled a DIFFERENT set of objects than the cold one');

  const expectedVolatile = new Map(OBJECTS_EXPECTED_VOLATILE.map((e) => [e.rel, e.because]));
  const volatileSeen = new Set();
  const mismatches = [];
  for (const rel of off.objects) {
    const [hOff, hCold, hWarm] = await Promise.all([
      sha256Of(path.join(off.objDir, rel)),
      sha256Of(path.join(onCold.objDir, rel)),
      sha256Of(path.join(onWarm.objDir, rel)),
    ]);
    if (hOff === hCold && hOff === hWarm) continue;
    if (expectedVolatile.has(rel)) { volatileSeen.add(rel); continue; }
    mismatches.push(`${rel}: off=${hOff.slice(0, 12)} on-cold=${hCold.slice(0, 12)} `
      + `on-warm=${hWarm.slice(0, 12)}`);
  }

  // THE ACCEPTANCE: every object ccache could have mis-served came out byte-identical to a
  // cache-off compile, whether ccache had never seen it before (on-cold) or was serving it
  // straight from cache (on-warm). This is a stronger, more precise claim than a whole-binary
  // hash comparison would have been -- see the file header for why that instrument was wrong
  // on this host, proven and not assumed.
  assert.deepStrictEqual(mismatches, [],
    `ccache served DIFFERENT bytes than a cache-off compile for ${mismatches.length} object(s) `
    + '-- this is the exact failure this task exists to catch, and it outranks any speedup:\n'
    + mismatches.join('\n'));

  // The exclusion's other half: a documented exception that stops matching reality is itself
  // a bug (the same discipline test/guards-population.cjs's own GUARD_EXCLUSIONS enforces for
  // its own list) -- if mimalloc's banner ever became reproducible, or a different object
  // started exhibiting the same symptom, this loop is what would say so instead of the
  // exclusion quietly covering for the wrong file.
  for (const rel of expectedVolatile.keys()) {
    assert.ok(volatileSeen.has(rel),
      `${rel} is listed in OBJECTS_EXPECTED_VOLATILE (${expectedVolatile.get(rel)}) but all `
      + 'three phases produced IDENTICAL bytes for it this run -- the exclusion is stale: '
      + 'remove it, or find the new source of nondeterminism if a DIFFERENT object needs it '
      + 'instead');
  }

  // THE OTHER HALF OF THE ACCEPTANCE: the hit rate, with absolute numbers, not just a
  // percentage (BACKLOG.md is where these get recorded for the record; this assertion is
  // what keeps that record honest on every future run).
  const cold = parseCcacheStats(statsCold);
  const warm = parseCcacheStats(statsWarm);
  assert.strictEqual(cold.hits, 0,
    `an EMPTY cache reported a hit -- something primed it before this run:\n${statsCold}`);
  assert.ok(warm.misses <= OBJECTS_EXPECTED_VOLATILE.length,
    `a fully warm rebuild missed ${warm.misses} time(s), more than the `
    + `${OBJECTS_EXPECTED_VOLATILE.length} object(s) already proven time-sensitive above:\n${statsWarm}`);

  const [hOffBin, hColdBin, hWarmBin] = await Promise.all(
    [off, onCold, onWarm].map((p) => sha256Of(p.enginePath)));
  console.log(`ccache-engine-e2e: wall clock off=${off.wallMs}ms on-cold=${onCold.wallMs}ms `
    + `on-warm=${onWarm.wallMs}ms`);
  console.log(`ccache-engine-e2e: cold cache stats -- ${cold.hits}/${cold.calls} hits`);
  console.log(`ccache-engine-e2e: warm cache stats -- ${warm.hits}/${warm.calls} hits, `
    + `${warm.misses} miss(es)`);
  // DIAGNOSTIC ONLY, deliberately not asserted -- see the file header's "FIRST THING THIS
  // TEST HAD TO PROVE" section. These three WILL differ from each other (a fresh LC_UUID per
  // link, plus mimalloc's build-banner byte) even though the assertions above already proved
  // every compiled object agrees; that is expected, not a regression, and asserting otherwise
  // here would make this gate flaky for a reason that has nothing to do with ccache.
  console.log(`ccache-engine-e2e: linked engine sha256 (diagnostic, expected to differ) `
    + `off=${hOffBin.slice(0, 12)} on-cold=${hColdBin.slice(0, 12)} on-warm=${hWarmBin.slice(0, 12)}`);
});

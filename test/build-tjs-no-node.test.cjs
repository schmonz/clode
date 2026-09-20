'use strict';
// ACCEPTANCE (spec §11.1): the engine build runs with Node ABSENT.
//
// This is the whole point of converting the orchestration to CJS. Until this
// test existed, "it could run without Node" was an argument; now it is a
// transcript. The shim hosts CommonJS and cannot host an ESM entry at all
// (libexec/node-shim/loader.cjs:481 guards its transpile with !isEntry), which
// is why the orchestration had to stop being ESM first.
//
// SCOPE, said plainly: this gate is HOST-LOCAL. It runs wherever a POSIX host
// has an engine (this laptop, and any CI job that exports CLODE_TJS — see
// below), but nothing yet schedules the orchestration under tjs as part of a
// LEG. Until the legs invoke build-tjs through the shim themselves, "the build
// needs no Node" is proven on the hosts that happen to run this file, not on
// the matrix.
//
// TWO ROWS, because --source-only and --build-only are two different claims.
// The first runs the source phase (file manipulation, patch replay, git); the
// second runs the phase that shells to cmake/ninja/tjsc and then EXECS the
// engine it produced. The build row is opt-in (CLODE_TJS_BUILD_GATE=1) because
// it compiles txiki.js for real; its own header says why, and what it costs.
// --regen-only is still proven under tjs by nothing, and cannot be until
// ensureEsbuild stops shelling to `npm` (scripts/build-tjs.cjs, ensureEsbuild)
// — npm is a Node program, so a node-free host has none.
//
// ENGINE RESOLUTION goes through node-shim-helper's tjsPath(), not a
// hand-rolled path join, for three reasons the first cut got wrong: (1) it
// honours CLODE_TJS, which is how CI points at its engine
// (`CLODE_TJS: ${{ runner.temp }}/tjs/tjs`, nine places in ci.yml) — a
// hand-rolled build-scratch path is never where CI puts it, so this gate
// skipped on every CI job while reporting "no engine — build one"; (2) it
// appends .exe on win32; (3) engineSpawn() routes a Cosmopolitan APE through
// the /bin/sh ENOEXEC trampoline instead of going RED with ENOEXEC.
//
// CAVEAT this test does NOT prove: build-tjs.cjs has exactly one surviving
// top-level `await` (`const cosmoccBin = await provisionCosmocc()`, guarded by
// `if (cosmoTarget)`). `cosmoTarget` is false on this leg (and every
// non-cosmo leg), so `--source-only` here never executes that async
// continuation under the shim. Only a `CLODE_TJS_TARGET=cosmo` run would
// exercise it, and that pulls a 441MB pinned download — out of scope for this
// gate. This test proves the synchronous orchestration path runs Node-free;
// it says nothing about the cosmo await path.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { tjsPath, engineSpawn, LOADER, REPO } = require('./node-shim-helper.cjs');
const { tjsBin, tjsVendorParentDir } = require('../scripts/platform-tag.cjs');
const { OK_TOKEN } = require('../scripts/engine-api-floor.cjs');

// A throwaway COPY of an EXISTING vendor checkout, never a virgin dir.
//
// WHY A COPY (the incident): the first cut passed the child only {PATH, HOME},
// so `--source-only` ran ensureCheckout -> resetCheckoutToPristine -> the whole
// patch stack replayed against the developer's SHARED
// ~/.cache/clode/tjs-vendor/txiki.js, as a side effect of `node test/run.mjs`.
// Warm dev-box state hid it: on that box the reset is a no-op-looking success,
// so the mutation was invisible.
//
// WHY NOT A FAKE TREE (measured, not assumed): the sibling
// build-tjs-continuation-scope test gets away with a 6-file stub because
// --regen-only takes --build-only's source handling and never calls
// ensureCheckout. --source-only DOES. Pointed at a stub tree it prints
// "missing .git/CMakeLists.txt (reaped?) — re-cloning" and pulls 785MB of
// txiki.js + submodules over the network, then `npm install`s esbuild — inside
// a run test/run.mjs:23 put in CLODE_OFFLINE=1 mode, because the child never
// sees that variable. That is strictly worse than the bug being fixed, and it
// is what this gate would now do on the nine CI jobs that export CLODE_TJS.
// Hence: SKIP unless a checkout already exists; never create one here.
//
// Prefer the filesystem's copy-on-write clone (APFS `cp -c`, ~2s for 785MB;
// GNU `cp --reflink=auto`) and fall back to a real copy. Correctness never
// depends on which one ran — only the wall clock does.
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


// ---- shared preconditions ---------------------------------------------------
// Both rows below need the SAME four things (a POSIX host, an engine, a warm
// vendor checkout, and a PATH that provably has no node on it), and the first
// cut of the --build-only row duplicated all four. Duplicated preconditions
// drift: the copy that stops matching is the one that starts skipping for the
// wrong reason, which is exactly how the --source-only row once told CI "no
// engine — build one" on nine jobs that HAD an engine (see the header).

// A PATH with no node on it, and still enough of a toolchain to compile with.
//
// THE PROBLEM THE FIRST CUT DID NOT HAVE: --source-only needs no tools beyond
// git, so a hardcoded '/usr/bin:/bin:/usr/sbin:/sbin' expresses "no node" for
// it. --build-only shells to cmake, ninja and ccache, and on this box all
// three live in /opt/pkg/bin — WHICH IS ALSO WHERE node LIVES. Dropping every
// PATH directory that contains a node therefore drops the compiler toolchain
// with it, and the run fails for a reason that has nothing to do with Node
// absence. Filtering by DIRECTORY cannot express this host at all.
//
// So filter by ENTRY: a farm of symlinks to every program on the ambient PATH
// except the Node family, first-wins so PATH precedence is preserved, with the
// POSIX floor behind it. That is what a node-free host looks like from inside
// the build, and it is the exact shape the phase-4c-1 proof run used.
const NODE_FAMILY = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack',
  'node.exe', 'npm.cmd', 'npx.cmd']);
const POSIX_FLOOR = '/usr/bin:/bin:/usr/sbin:/sbin';
function nodeFreePath(farmDir) {
  fs.mkdirSync(farmDir, { recursive: true });
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries) {
      if (NODE_FAMILY.has(name)) continue;
      const link = path.join(farmDir, name);
      if (fs.existsSync(link)) continue; // first wins: PATH precedence
      try { fs.symlinkSync(path.join(d, name), link); } catch { /* racy dir, skip */ }
    }
  }
  return `${farmDir}${path.delimiter}${POSIX_FLOOR}`;
}

// Returns { srcCheckout, bare } or null after calling t.skip with the reason.
// Every refusal names what is missing AND how to supply it, because a skip
// nobody can act on is a test that quietly stopped existing.
function preflight(t, farmDir) {
  // POSIX-only, and say so rather than letting it look like a missing engine.
  // The probe below is `sh -c 'command -v node'`; there is no Windows
  // equivalent of "a PATH with no node on it" that this file expresses. Before
  // this skip existed, Windows fell through to the engine check, found no
  // `.../tjs` (it is `tjs.exe` there) and told a developer who HAS an engine to
  // go build one.
  if (process.platform === 'win32') {
    t.skip('POSIX-only: this gate proves Node-absence with `sh -c \'command -v node\'` '
      + 'and a synthesized POSIX PATH — not a missing engine');
    return null;
  }
  if (!tjsPath()) {
    t.skip(`no engine (CLODE_TJS or ${tjsBin(REPO)}) — build one with \`node scripts/build-tjs.cjs\``);
    return null;
  }
  // A warm vendor checkout is a PRECONDITION, not something this gate creates
  // (see copyCheckout above for the 785MB reason).
  const srcCheckout = path.join(tjsVendorParentDir(), 'txiki.js');
  if (!fs.existsSync(path.join(srcCheckout, '.git'))) {
    t.skip(`no vendor checkout at ${srcCheckout} — run \`node scripts/build-tjs.cjs --source-only\` `
      + 'once; this gate copies an existing checkout and will not clone 785MB inside a test run');
    return null;
  }
  // If node were reachable the run would prove nothing, so establish its
  // absence before asserting anything else. A host whose POSIX floor itself
  // ships a node (some distro images put it in /usr/bin) cannot express this
  // condition at all — that is a SKIP with the reason spelled out, not a
  // failure, and not a silent pass.
  const bare = nodeFreePath(farmDir);
  const probe = spawnSync('sh', ['-c', 'command -v node || true'],
    { env: { PATH: bare }, encoding: 'utf8' });
  if (probe.stdout.trim()) {
    t.skip(`node is still reachable at ${probe.stdout.trim()} on the synthesized node-free PATH `
      + `(it is inside the POSIX floor ${POSIX_FLOOR}, which this gate cannot drop without `
      + 'losing sh/cc) — this host cannot express "no node" and the gate would prove nothing');
    return null;
  }
  return { srcCheckout, bare };
}

test('the SOURCE phase runs with Node absent from PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-no-node-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const pre = preflight(t, path.join(dir, 'nodefree-bin'));
  if (!pre) return;

  // Scrubbed and redirected rather than inherited: the env below is BUILT UP,
  // so no ambient CLODE_* knob (CLODE_TJS_TARGET=cosmo above all, which would
  // try to fetch 441MB) can steer the child, and every path it writes to is
  // under the throwaway dir.
  copyCheckout(pre.srcCheckout, path.join(dir, 'txiki.js'));
  const env = {
    PATH: pre.bare,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: dir,
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_DEPS: path.join(dir, 'deps'),
  };

  const [cmd, argv] = engineSpawn(['run', LOADER, path.join(REPO, 'scripts/build-tjs.cjs'), '--source-only']);
  const r = spawnSync(cmd, argv, { cwd: REPO, env, encoding: 'utf8', timeout: 600000 });

  assert.strictEqual(r.status, 0,
    `build-tjs.cjs failed under the shim with no Node:\n${r.stdout}\n${r.stderr}`);
  // Status alone is NOT enough, and build-tjs.cjs's continuation catch says why
  // in its own words: "under tjs an unhandled rejection can be swallowed
  // outright — so a failed build would have reported success." Exit 0 is exactly
  // what that failure mode produces. Assert the marker the source phase prints
  // when it actually finished.
  assert.match(r.stdout, /source tree ready:/,
    'the build exited 0 without reaching its source-phase marker — a swallowed '
    + `rejection looks exactly like this:\n${r.stdout}\n${r.stderr}`);
});

// ---- the BUILD phase, which is a different question -------------------------
// The row above proves the orchestration LOADS and runs its synchronous source
// handling under the shim. It proves nothing about --build-only, which is where
// build-tjs.cjs stops manipulating files and starts SHELLING OUT: cmake
// configure (twice — once to get a host tjsc, once with -DCLODE_HOST_TJSC),
// cmake --build, the host tjsc itself, and finally an exec of the engine it
// just produced for the engine-API-floor smoke. Every one of those is
// child_process under node-shim, and until this row existed `--build-only`
// under tjs was proven by NOTHING. (Recorded as the gating unknown in
// .superpowers/sdd/node-removal-recon.md, "Undetermined".)
//
// THE MARKER IS THE POINT. `built <engine> (tjs-shim-ok)` is printed only after
// the compile finished, the exe landed in outDir, AND that exe was EXECUTED and
// answered the engine-API floor check with OK_TOKEN. A truncated build, a
// swallowed rejection, a cmake that configured and did nothing, an engine
// missing a binding — none of them can produce that line. Exit 0 can: this repo
// has had --version, --help and bare exit 0 each certify a broken build.
// OK_TOKEN is IMPORTED rather than spelled 'tjs-shim-ok' here, so the one list
// in scripts/engine-api-floor.cjs stays the only place that word is chosen.
//
// PROVEN TO BE ABLE TO FAIL (2026-09-19, this box, RUN — not reasoned), twice,
// because the two assertions guard two different failure modes:
//   * status. The same command over the same checkout with
//     `#error clode-control-sabotage` appended to src/vm.c exited 1 and printed
//     ZERO `built ... (` lines.
//   * marker. Swapping this row's flag to --source-only — a run that exits 0,
//     prints a cheerful completion line, and never compiles anything — turned
//     this row RED on the marker assertion in 10s. That is the exact shape of
//     every gate this repo has been burned by, and it does not pass here.
//
// OPT-IN, and this is a real cost, not a formality. The source row above takes
// ~11s; this one takes ~68s with a warm ccache on an M-series Mac and several
// minutes cold. The nine CI jobs that export CLODE_TJS would each grow a full
// engine build, all of them compiling a tree their own job already built. So it
// gates on CLODE_TJS_BUILD_GATE=1, the same shape as the CLODE_LIVE_RENDER
// opt-in — and, like that one, the intent is that a DELIBERATELY CHOSEN leg
// sets it once the legs themselves move to the shim, not that it stays unrun.
test('the BUILD phase produces a working engine with Node absent from PATH', (t) => {
  if (process.env.CLODE_TJS_BUILD_GATE !== '1') {
    t.skip('opt-in: set CLODE_TJS_BUILD_GATE=1 to run a full engine build under the shim '
      + '(~68s warm, minutes cold — it compiles txiki.js for real)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-no-node-build-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const pre = preflight(t, path.join(dir, 'nodefree-bin'));
  if (!pre) return;

  // --build-only demands an ALREADY-PATCHED tree and never patches one itself,
  // so the warm checkout is copied in exactly as the source row copies it — and
  // CLODE_TJS_OUT is redirected, which the source row does not need. Without it
  // the build would overwrite platformTjsDir's tjs: the very binary this test
  // is running the orchestration ON, mid-test.
  copyCheckout(pre.srcCheckout, path.join(dir, 'txiki.js'));
  const out = path.join(dir, 'out');
  const env = {
    PATH: pre.bare,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: dir,
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_TJS_OUT: out,
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_DEPS: path.join(dir, 'deps'),
  };

  const [cmd, argv] = engineSpawn(['run', LOADER, path.join(REPO, 'scripts/build-tjs.cjs'), '--build-only']);
  const r = spawnSync(cmd, argv, { cwd: REPO, env, encoding: 'utf8', timeout: 3600000 });

  assert.strictEqual(r.status, 0,
    `--build-only failed under the shim with no Node:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^built .*\\(${OK_TOKEN}\\)$`, 'm'),
    'the build exited 0 without printing its completed-build marker, so either the compile '
    + 'never finished or the engine it produced failed the API-floor smoke:\n'
    + `${r.stdout}\n${r.stderr}`);
  // And the artifact is on disk where outDir says, not merely announced. The
  // marker is printed BEFORE checkHermeticDeps, so a run that printed it and
  // then lost the file is a state this assertion can still catch.
  const engine = path.join(out, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
  assert.ok(fs.existsSync(engine), `--build-only printed its marker but left no engine at ${engine}`);
});

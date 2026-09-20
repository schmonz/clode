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
// All three rows below need the SAME four things (a POSIX host, an engine, a
// warm vendor checkout, and a PATH that provably has no node on it), and the
// first cut of the --build-only row duplicated all four. Duplicated preconditions
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
// the build, and it is the exact shape the 2026-09-19 proof runs of all three
// modes used before any of this was committed.
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

// ---- the one place the source phase still needs Node ------------------------
// ensureEsbuild shells to `npm install --no-save esbuild@0.28.1` into the txiki
// checkout. npm is a Node program, so on a node-free host it cannot run — which
// makes `--source-only` Node-free only by ACCIDENT, on a checkout that already
// has node_modules/.bin/esbuild. The row at the top of this file copies exactly
// such a warm checkout, so its `existsSync` short-circuits and the gap never
// shows: the recon (.superpowers/sdd/node-removal-recon.md, "Gaps" 2) called
// this out as a gate that cannot fail. This row defeats the short-circuit by
// deleting node_modules from its copy.
//
// MEASURED (this box, 2026-09-19): before CLODE_ESBUILD existed, that run died
// with `Error: spawnSync npm ENOENT` — a message that names neither esbuild,
// nor the pin, nor anything a reader could act on. It now refuses by name and
// offers the seam, and the seam WORKS: given an esbuild binary, the whole
// source phase completes with no Node anywhere.
//
// SCOPE, so this is not mistaken for the fix, and the scope is narrower than
// the first draft of this comment claimed. CLODE_ESBUILD is the seam, not the
// provisioning, and it covers only the BUNDLER. The same `npm install` also
// populates txiki's own JS dependency tree, which esbuild bundles — see the
// fixture below. So a cold checkout on a node-free host needs BOTH a bundler
// and that tree; this seam supplies the first. Where a node-free leg gets
// either is still open — .superpowers/sdd/node-removal-phase1.md.
test('the source phase names its esbuild need instead of ENOENTing on npm', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-esbuild-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const pre = preflight(t, path.join(dir, 'nodefree-bin'));
  if (!pre) return;
  // The override needs a REAL esbuild to point at, and the warm checkout is
  // where this repo already has one. No esbuild anywhere means the second half
  // of this row would be testing the error path twice.
  const realEsbuild = path.join(pre.srcCheckout, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(realEsbuild)) {
    t.skip(`no esbuild at ${realEsbuild} — run \`node scripts/build-tjs.cjs --source-only\` once `
      + 'with Node available so the checkout has one to point CLODE_ESBUILD at');
    return;
  }

  // ONLY the esbuild packages, NOT all of node_modules — and the difference is
  // a finding, not a nicety. `npm install --no-save esbuild@0.28.1` runs inside
  // a checkout whose OWN package.json declares web-streams-polyfill,
  // urlpattern-polyfill, ipaddr.js, uuid, getopts, @jsr/std__tar and
  // @jridgewell/trace-mapping, so it materializes all of those too — and
  // esbuild BUNDLES them (src/js/polyfills/index.js literally
  // `import 'web-streams-polyfill/polyfill'`). Deleting node_modules wholesale,
  // as the first cut did, therefore deletes real BUILD INPUTS and the run dies
  // with `Could not resolve "web-streams-polyfill/polyfill"` — a fixture
  // artifact that says nothing about esbuild. The state modelled here is the
  // one CLODE_ESBUILD actually addresses: the checkout's JS dep tree is present
  // (it rides in the cached vendor checkout every leg restores), the BUNDLER is
  // not, and there is no npm to fetch one.
  const checkout = path.join(dir, 'txiki.js');
  copyCheckout(pre.srcCheckout, checkout);
  for (const p of ['node_modules/.bin/esbuild', 'node_modules/.bin/esbuild.cmd',
    'node_modules/esbuild', 'node_modules/@esbuild']) {
    fs.rmSync(path.join(checkout, p), { recursive: true, force: true });
  }
  const baseEnv = {
    PATH: pre.bare,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: dir,
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_DEPS: path.join(dir, 'deps'),
  };
  const [cmd, argv] = engineSpawn(['run', LOADER, path.join(REPO, 'scripts/build-tjs.cjs'), '--source-only']);
  const sourceOnly = (env) => spawnSync(cmd, argv,
    { cwd: REPO, env, encoding: 'utf8', timeout: 600000 });

  // (a) no esbuild, no npm: refuse by name. An opaque ENOENT here is the bug.
  const bad = sourceOnly(baseEnv);
  assert.notStrictEqual(bad.status, 0, 'a checkout with no esbuild and a PATH with no npm '
    + `must not succeed — that would mean esbuild never ran:\n${bad.stdout}\n${bad.stderr}`);
  const why = `${bad.stdout}${bad.stderr}`;
  assert.match(why, /esbuild@0\.28\.1/, `the refusal must name the pin it wanted:\n${why}`);
  assert.match(why, /CLODE_ESBUILD/, `the refusal must name the way out:\n${why}`);
  assert.doesNotMatch(why, /spawnSync npm ENOENT/,
    `the refusal must explain itself, not leak npm's ENOENT:\n${why}`);

  // (b) the same run, handed an esbuild: the whole source phase, no Node.
  const good = sourceOnly({ ...baseEnv, CLODE_ESBUILD: realEsbuild });
  assert.strictEqual(good.status, 0,
    `CLODE_ESBUILD did not carry the source phase through:\n${good.stdout}\n${good.stderr}`);
  assert.match(good.stdout, /source tree ready:/,
    `exited 0 without reaching the source-phase marker:\n${good.stdout}\n${good.stderr}`);
});

// ---- the COLD checkout, which is the state the warm rows cannot express ------
//
// Every row above copies a WARM checkout: node_modules present, esbuild inside it. That is
// the state a dev box and a cache-hit leg are in, and in that state the source phase's two
// JS-bundle inputs are both satisfied by accident, so nothing about provisioning them is
// ever exercised. The row just above defeats HALF of that masking (it deletes the esbuild
// packages) — deliberately, because the state CLODE_ESBUILD addresses is "bundler missing,
// dep tree present". Nothing defeated the OTHER half.
//
// This row does: it deletes node_modules OUTRIGHT, which is what a cache MISS leaves behind
// (node_modules is not in git; only `npm install` inside the checkout puts it there). On a
// node-free host that tree can satisfy neither input, and BOTH of the ways it used to fail
// were measured on this box, 2026-09-20, before the gate existed:
//
//   * no bundler, no npm: the ensureEsbuild refusal, which names the pin and CLODE_ESBUILD
//     and says nothing whatsoever about the seven packages the bundle step ALSO needs — so
//     an operator who acts on it lands straight in the next failure. It arrived after all
//     25 patches and all ~50 source fixups had already been applied and logged.
//   * handed a CLODE_ESBUILD: `Error: Command failed: <...>/node_modules/.bin/esbuild`, and
//     nothing else. Under the shim esbuild's own `Could not resolve
//     "web-streams-polyfill/polyfill"` does not even reach the operator's terminal, so the
//     entire diagnosis available was the path of the binary that exited nonzero.
//
// So the claim under test is not "it fails" — it already did, twice — but that it refuses
// UP FRONT and names BOTH halves. Two invocations, because supplying the bundler must not
// make the second half go quiet.
test('a COLD checkout is refused by name, both halves, before any bundling is attempted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-cold-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const pre = preflight(t, path.join(dir, 'nodefree-bin'));
  if (!pre) return;
  const realEsbuild = path.join(pre.srcCheckout, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(realEsbuild)) {
    t.skip(`no esbuild at ${realEsbuild} — run \`node scripts/build-tjs.cjs --source-only\` once `
      + 'with Node available so the checkout has one to point CLODE_ESBUILD at');
    return;
  }

  const checkout = path.join(dir, 'txiki.js');
  copyCheckout(pre.srcCheckout, checkout);
  // THE WHOLE TREE, not the esbuild packages alone — this is the cold state, and it is
  // safe on the COPY (the CoW clone above means nothing here touches the shared checkout).
  fs.rmSync(path.join(checkout, 'node_modules'), { recursive: true, force: true });
  const baseEnv = {
    PATH: pre.bare,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: dir,
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_DEPS: path.join(dir, 'deps'),
  };
  const [cmd, argv] = engineSpawn(['run', LOADER, path.join(REPO, 'scripts/build-tjs.cjs'), '--source-only']);
  const sourceOnly = (env) => spawnSync(cmd, argv,
    { cwd: REPO, env, encoding: 'utf8', timeout: 600000 });

  // (a) neither input available, and no npm to fetch either.
  const cold = sourceOnly(baseEnv);
  assert.notStrictEqual(cold.status, 0,
    `a cold checkout cannot build the js bundles and must not exit 0:\n${cold.stdout}\n${cold.stderr}`);
  const why = `${cold.stdout}${cold.stderr}`;
  assert.match(why, /esbuild@0\.28\.1/, `half one, the bundler, must be named by pin:\n${why}`);
  assert.match(why, /CLODE_ESBUILD/, `half one must name its seam:\n${why}`);
  assert.match(why, /web-streams-polyfill/,
    `half two, txiki's own bundled dep tree, must be named package by package:\n${why}`);
  assert.doesNotMatch(why, /spawnSync npm ENOENT/,
    `the refusal must explain itself, not leak npm's ENOENT:\n${why}`);
  // UP FRONT is half the claim, and this is the assertion that holds it: the old refusal
  // arrived after every source fixup had run and logged. Patches above the gate may have
  // applied (the gate reads the patched tree on purpose); a single `fixup ` line means the
  // check drifted back down the file to where it cannot save anyone the work.
  assert.doesNotMatch(why, /^fixup /m,
    `the refusal must precede the source fixups, not follow all ~50 of them:\n${why}`);

  // (b) handed a bundler, the OTHER half must still refuse — and must not go on claiming
  // the bundler is what is missing. This is the half a warm checkout can never show.
  const withBundler = sourceOnly({ ...baseEnv, CLODE_ESBUILD: realEsbuild });
  assert.notStrictEqual(withBundler.status, 0,
    'a bundler with nothing to bundle is not a satisfied source phase:\n'
    + `${withBundler.stdout}\n${withBundler.stderr}`);
  const why2 = `${withBundler.stdout}${withBundler.stderr}`;
  assert.match(why2, /web-streams-polyfill/, `name the dep tree:\n${why2}`);
  // The measured red for this half, verbatim: esbuild was reached, exited nonzero, and the
  // only thing said about it was its own path.
  assert.doesNotMatch(why2, /Command failed:/,
    `this half must be refused by name, not by a bundler exiting nonzero:\n${why2}`);
  assert.doesNotMatch(why2, /source tree ready:/,
    `a refused source phase must not also announce success:\n${why2}`);
});

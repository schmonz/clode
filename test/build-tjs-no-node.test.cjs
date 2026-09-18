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

test('the engine build runs with Node absent from PATH', (t) => {
  // POSIX-only, and say so rather than letting it look like a missing engine.
  // The probe below is `sh -c 'command -v node'` against a hardcoded POSIX
  // PATH; there is no Windows equivalent of "a PATH with no node on it" that
  // this file expresses. Before this skip existed, Windows fell through to the
  // engine check, found no `.../tjs` (it is `tjs.exe` there) and told a
  // developer who HAS an engine to go build one.
  if (process.platform === 'win32') {
    t.skip('POSIX-only: this gate proves Node-absence with `sh -c \'command -v node\'` ' +
           'and a hardcoded POSIX PATH — not a missing engine');
    return;
  }
  if (!tjsPath()) {
    t.skip(`no engine (CLODE_TJS or ${tjsBin(REPO)}) — build one with \`node scripts/build-tjs.cjs\``);
    return;
  }
  // A warm vendor checkout is a PRECONDITION, not something this gate creates
  // (see copyCheckout above for the 785MB reason).
  const srcCheckout = path.join(tjsVendorParentDir(), 'txiki.js');
  if (!fs.existsSync(path.join(srcCheckout, '.git'))) {
    t.skip(`no vendor checkout at ${srcCheckout} — run \`node scripts/build-tjs.cjs --source-only\` ` +
           'once; this gate copies an existing checkout and will not clone 785MB inside a test run');
    return;
  }
  // A PATH with no node on it. If node were reachable the run would prove
  // nothing, so assert its absence before asserting anything else.
  const bare = '/usr/bin:/bin:/usr/sbin:/sbin';
  const probe = spawnSync('sh', ['-c', 'command -v node || true'],
    { env: { PATH: bare }, encoding: 'utf8' });
  assert.strictEqual(probe.stdout.trim(), '',
    `node is reachable on the bare PATH (${probe.stdout.trim()}) — this test cannot prove anything`);

  // Scrubbed and redirected rather than inherited: the env below is BUILT UP,
  // so no ambient CLODE_* knob (CLODE_TJS_TARGET=cosmo above all, which would
  // try to fetch 441MB) can steer the child, and every path it writes to is
  // under the throwaway dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-no-node-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  copyCheckout(srcCheckout, path.join(dir, 'txiki.js'));
  const env = {
    PATH: bare,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: dir,
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_CACHE: path.join(dir, 'cache'),
  };

  const [cmd, argv] = engineSpawn(['run', LOADER, path.join(REPO, 'scripts/build-tjs.cjs'), '--source-only']);
  const r = spawnSync(cmd, argv, { cwd: REPO, env, encoding: 'utf8', timeout: 600000 });

  assert.strictEqual(r.status, 0,
    `build-tjs.cjs failed under the shim with no Node:\n${r.stdout}\n${r.stderr}`);
  // Status alone is NOT enough, and build-tjs.cjs:3861 says why in its own
  // words: "under tjs an unhandled rejection can be swallowed outright — so a
  // failed build would have reported success." Exit 0 is exactly what that
  // failure mode produces. Assert the marker the source phase prints when it
  // actually finished.
  assert.match(r.stdout, /source tree ready:/,
    `the build exited 0 without reaching its source-phase marker — a swallowed ` +
    `rejection looks exactly like this:\n${r.stdout}\n${r.stderr}`);
});

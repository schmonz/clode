'use strict';
// THE ACCEPTANCE: a genuinely COLD vendor checkout completes `--source-only` with no npm
// and no node anywhere on PATH, and produces BYTE-IDENTICAL bundles to a warm one.
//
// WHY THIS FILE AND NOT A ROW IN build-tjs-no-node.test.cjs. Every row there copies a WARM
// checkout — node_modules present, esbuild inside it — so `existsSync` short-circuits and
// the provisioning path is never entered. That file's cold row deletes node_modules, but
// its claim is that the run REFUSES by name. This one's claim is the opposite: that the
// same cold tree now SUCCEEDS, which is a different assertion needing a different setup
// (a network, and an opt-in to reach it).
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS.
//   1. cold succeeds. Necessary, and by itself worth very little: this repo has had
//      --version, --help and a bare exit 0 each certify a broken build, and
//      build-tjs.cjs's own continuation catch records that under tjs a swallowed rejection
//      LOOKS like success. So `source tree ready:` is asserted, and so is the provisioner's
//      own line, so a run that silently found a warm tree cannot pass as a cold one.
//   2. cold == warm, byte for byte, over every file under src/bundles/js/**. Provisioning
//      that produces DIFFERENT bundles is not a win, it is a silent correctness bug: those
//      bundles become the bytecode arrays the engine ships. A different esbuild minifies
//      differently, which is the whole reason the pin is load-bearing and the reason
//      ensureEsbuild refuses an esbuild found on PATH. This half is what proves the
//      provisioned bundler and dep tree are the SAME inputs npm would have installed.
//
// ONLINE, and therefore opt-in. test/run.mjs forces CLODE_OFFLINE=1 (test/run.mjs:23), so
// this needs CLODE_BUNDLE_INPUTS_ONLINE=1 — same shape as CLODE_BOOTSTRAP_ONLINE and
// CLODE_CCACHE_ENGINE_E2E. The fetch is ~6MB and ~2s; the two source phases either side of
// it are ~13s each.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineSpawn, LOADER, REPO } = require('./node-shim-helper.cjs');
const { copyCheckout, nodeFreePreflight, sha256OfSync } = require('./engine-build-harness.cjs');

function why() {
  if (process.env.CLODE_BUNDLE_INPUTS_ONLINE !== '1') {
    return 'opt-in: set CLODE_BUNDLE_INPUTS_ONLINE=1 (fetches ~6MB of pinned npm tarballs '
      + 'and runs two real source phases, ~30s) — this is the gate that answers "can a cold '
      + 'checkout build the bundles with no npm?"';
  }
  if (process.env.CLODE_OFFLINE === '1') {
    return 'CLODE_OFFLINE=1 — run the suite with `node test/run.mjs --online`, or this file '
      + 'directly, to let it reach the network it exists to reach';
  }
  return null;
}

// Every file under src/bundles/js/**, path -> sha256. The esbuild INPUT manifest
// (.clode-inputs.json) is included on purpose: it records one sha256 per file esbuild
// actually read, so if the two runs disagreed about which sources went in, that file
// differs even where the minified output happened not to.
function bundleDigests(checkout) {
  const root = path.join(checkout, 'src/bundles/js');
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else out[next] = sha256OfSync(path.join(root, next));
    }
  };
  walk('');
  return out;
}

test('a COLD checkout builds the same bundles as a warm one, with no npm and no node', (t) => {
  const skip = why();
  if (skip) return t.skip(skip);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tjs-cold-provision-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const pre = nodeFreePreflight(t, path.join(dir, 'nodefree-bin'));
  if (!pre) return;

  // TWO SEPARATE VENDOR PARENTS, because CLODE_TJS_VENDOR names the PARENT of txiki.js and
  // build-tjs.cjs always builds `<vendor>/txiki.js`. One dir per run keeps the two trees
  // from being the same tree, which is the only way the comparison below means anything.
  const mk = (name, cold) => {
    const parent = path.join(dir, name);
    fs.mkdirSync(parent, { recursive: true });
    const checkout = path.join(parent, 'txiki.js');
    copyCheckout(pre.srcCheckout, checkout);
    // COLD IS COLD: the whole tree, not the esbuild packages alone. node_modules is not in
    // git — only `npm install` inside the checkout puts it there — so this is exactly what
    // a cache MISS leaves behind, and it is what defeats the existsSync short-circuit
    // every warm row inherits.
    if (cold) fs.rmSync(path.join(checkout, 'node_modules'), { recursive: true, force: true });
    return { parent, checkout };
  };

  const sourceOnly = (parent, extra = {}) => {
    const [cmd, argv] = engineSpawn(['run', LOADER,
      path.join(REPO, 'scripts/build-tjs.cjs'), '--source-only']);
    return spawnSync(cmd, argv, {
      cwd: REPO,
      // Built up, never inherited: an ambient CLODE_TJS_TARGET=cosmo would steer this
      // somewhere else entirely and the assertions would describe a different code path.
      env: {
        PATH: pre.bare,
        HOME: process.env.HOME,
        CLODE_TJS_VENDOR: parent,
        CLODE_TJS_BUILD: path.join(parent, 'build'),
        CLODE_CACHE: path.join(dir, 'cache'),   // shared: the fetch happens once
        CLODE_DEPS: path.join(parent, 'deps'),
        ...extra,
      },
      encoding: 'utf8',
      timeout: 900000,
    });
  };

  const warm = mk('warm', false);
  const cold = mk('cold', true);
  assert.ok(!fs.existsSync(path.join(cold.checkout, 'node_modules')),
    'the cold tree still has a node_modules — this row would then prove nothing');

  const wr = sourceOnly(warm.parent);
  assert.strictEqual(wr.status, 0, `the WARM baseline failed:\n${wr.stdout}\n${wr.stderr}`);
  assert.match(wr.stdout, /source tree ready:/, `warm baseline never finished:\n${wr.stdout}`);
  // The warm path must NOT provision: a warm checkout satisfies both inputs already, and a
  // fetch there would mean the network is on the normal dev/CI path. Silence is the claim.
  assert.doesNotMatch(`${wr.stdout}${wr.stderr}`, /bundle inputs: provisioning/,
    `a warm checkout must never reach the network:\n${wr.stdout}\n${wr.stderr}`);

  const cr = sourceOnly(cold.parent);
  const coldOut = `${cr.stdout}${cr.stderr}`;
  assert.strictEqual(cr.status, 0, `the COLD checkout did not complete --source-only:\n${coldOut}`);
  assert.match(cr.stdout, /source tree ready:/,
    'exit 0 without the source-phase marker is exactly what a swallowed rejection looks '
    + `like under tjs:\n${coldOut}`);
  // It really took the cold path. Without this, a copyCheckout that quietly preserved
  // node_modules would make this row pass while testing the warm path twice.
  assert.match(coldOut, /bundle inputs: provisioning/,
    `the cold run never entered the provisioning path:\n${coldOut}`);
  assert.match(coldOut, /web-streams-polyfill/,
    `the cold run must name what it provisioned, package by package:\n${coldOut}`);
  assert.doesNotMatch(coldOut, /spawnSync npm ENOENT/, `npm must never be reached:\n${coldOut}`);
  // The gate is unchanged and still runs; it simply has nothing left to refuse.
  assert.doesNotMatch(coldOut, /cannot build the txiki JS bundles/,
    `provisioning ran and the gate still refused:\n${coldOut}`);
  // The bundler it used is the provisioned native binary, not a node wrapper: there is no
  // node to run a wrapper with, so this is load-bearing rather than cosmetic.
  const esb = path.join(cold.checkout, 'node_modules/.bin/esbuild');
  assert.ok(fs.existsSync(esb), `no provisioned bundler at ${esb}`);
  const ver = spawnSync(esb, ['--version'], { encoding: 'utf8', env: { PATH: pre.bare } });
  assert.strictEqual(ver.stdout.trim(), '0.28.1',
    `the provisioned bundler is not the pin:\n${ver.stdout}${ver.stderr}`);

  // ---- THE HALF THAT MATTERS ------------------------------------------------
  const warmD = bundleDigests(warm.checkout);
  const coldD = bundleDigests(cold.checkout);
  // 17 today: the four JS_BUNDLES, twelve src/js/stdlib/*.js, and the esbuild input
  // manifest. A floor rather than an equality, so adding a stdlib module is not a test
  // change — but a floor at all, because an empty or half-written src/bundles/js would
  // otherwise let deepStrictEqual([], []) declare two broken runs identical.
  assert.ok(Object.keys(warmD).length >= 16,
    `only ${Object.keys(warmD).length} bundle files — the baseline itself looks wrong`);
  assert.deepStrictEqual(Object.keys(coldD).sort(), Object.keys(warmD).sort(),
    'the cold run produced a different SET of bundles than the warm run');
  const differing = Object.keys(warmD).filter((k) => warmD[k] !== coldD[k]);
  assert.deepStrictEqual(differing, [],
    'provisioned inputs produced DIFFERENT bundles than npm-installed ones. These bytes '
    + 'become the bytecode arrays the engine ships, so this is a silent correctness bug, '
    + `not a cosmetic diff:\n${differing.map((k) => `  ${k}: warm ${warmD[k]} cold ${coldD[k]}`).join('\n')}`);
});

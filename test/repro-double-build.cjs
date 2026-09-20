#!/usr/bin/env node
'use strict';
// repro-double-build — build the engine TWICE from identical sources and compare the
// whole binary.
//
// THE PROPERTY. A cache that returns a different object than a fresh compile is the one
// failure mode that matters, and "build twice, compare the whole binary" is the only check
// that catches it without trusting the cache's own accounting. The standing bar this serves
// is stated in BACKLOG.md: ccache is not "done" until every leg has a reproducibility
// verdict. test/repro-verdicts.cjs is where those verdicts live; this file is how one is
// EARNED.
//
// WHY THIS IS NOT test/ccache.test.cjs. That file already byte-compares 372 objects and the
// linked engine across three phases, and it is the stronger instrument for the question it
// asks (did the CACHE mis-serve an object). It is also three engine builds, host-only, and
// keyed to a real ccache install. The question HERE is different and weaker on purpose:
// given a leg and its release engine config, do TWO builds produce the same bytes? That is
// answerable on a leg with no ccache at all, which is most of them. Both call the same
// machinery in test/engine-build-harness.cjs, so neither can drift from the other.
//
// HOW IT IS RUN, and the cost that shapes that:
//
//   node test/repro-double-build.cjs --leg darwin-arm64
//
// One leg, two builds, one verdict, exit 0 or 1. A human runs it for one leg;
// .github/workflows/repro.yml runs it weekly for the legs where it is cheap. It is NOT in
// the default suite: double-building doubles engine build time, which is ~2 minutes on
// darwin/linux and ~4 HOURS on netbsd-mips64eb (115 minutes cold, measured). Every leg too
// slow to double-build carries `unproven` with that stated as the reason, so the gap is
// visible rather than silent.
//
// THE ONE RULE IT CANNOT BREAK: both phases build to the SAME outDir and are snapshotted
// under the SAME basename. compareArtifacts() refuses anything else — on mach-o the ad-hoc
// signature's identifier derives from the output FILENAME, so differently-named outputs
// manufacture a phantom one-byte delta.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyCheckout, findBuildDir, snapshotPhase, compareArtifacts, runEngineBuild,
  ENGINE_BUILD_TIMEOUT_MS, REPO,
} = require('./engine-build-harness.cjs');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

// The engine config a leg SHIPS with, translated to build-tjs.cjs's own knobs. Derived
// from scripts/tjs-legs.mjs, never retyped: the linux-x64-glibc proof was first run with
// WASM off while the release leg builds it on, and a verdict measured against a config the
// leg does not ship is a verdict about nothing. `undefined` on a knob means the leg takes
// build-tjs.cjs's default for the host, which is what that leg's CI job does too.
function legBuildEnv(leg) {
  const env = {};
  if (leg.wasm !== undefined) env.CLODE_TJS_WASM = String(leg.wasm);
  if (leg.mimalloc !== undefined) env.CLODE_TJS_MIMALLOC = String(leg.mimalloc);
  if (leg.ffi !== undefined) env.CLODE_TJS_FFI = String(leg.ffi);
  if (leg.static) env.CLODE_TJS_STATIC = '1';
  return env;
}

// A one-line, greppable description of what was actually built — the thing a verdict is
// ABOUT. Recorded in the observation so a proof in test/repro-verdicts.cjs can never be
// read as covering a config it did not cover.
function describeConfig(buildEnv) {
  const knobs = ['CLODE_TJS_WASM', 'CLODE_TJS_MIMALLOC', 'CLODE_TJS_FFI', 'CLODE_TJS_STATIC'];
  const parts = knobs.map((k) => `${k.replace('CLODE_TJS_', '').toLowerCase()}=${buildEnv[k] ?? 'default'}`);
  return parts.join(' ');
}

// THE CAPABILITY. Two builds, identical inputs, identical output path, whole-binary
// compare. Returns an OBSERVATION — a fact about what happened — and judges nothing;
// test/repro-verdicts.cjs's judgeObservation() decides what it means for a given leg.
//
// `perturb` is the seam that lets this be shown able to FAIL against real builds rather
// than only against synthetic fixtures: it runs between the two builds, against the
// throwaway checkout, and is absent on every real run.
function doubleBuildEngine({
  legName,
  buildEnv = {},
  sharedCheckout = path.join(tjsVendorParentDir(process.env), 'txiki.js'),
  workDir,
  timeoutMs = ENGINE_BUILD_TIMEOUT_MS,
  log = () => {},
  perturb = null,
} = {}) {
  if (!fs.existsSync(path.join(sharedCheckout, 'CMakeLists.txt'))) {
    throw new Error(`no vendor checkout at ${sharedCheckout} — run `
      + '`node scripts/build-tjs.cjs --source-only` once first; this runner COPIES an '
      + 'existing checkout and will not clone 785MB inside a gate');
  }
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'repro-double-build-'));
  const vendorParent = path.join(dir, 'vendor');
  fs.mkdirSync(vendorParent, { recursive: true });
  const tree = path.join(vendorParent, 'txiki.js');
  log(`copying ${sharedCheckout} -> ${tree}`);
  copyCheckout(sharedCheckout, tree);

  // outDir and buildRoot are FIXED across both phases, deliberately. Two builds into two
  // different outDir paths bake that path's own string into their objects (the C sources
  // use __FILE__-style absolute paths in places), which reads as a "difference" that is
  // really two builds disagreeing about where they were told to live. Holding both
  // constant and WIPING buildRoot between phases isolates the one question being asked.
  const outDir = path.join(dir, 'out');
  const buildRoot = path.join(dir, 'build-root');
  const snapshotsRoot = path.join(dir, 'snapshots');
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: vendorParent,
    CLODE_TJS_OUT: outDir,
    CLODE_TJS_BUILD: buildRoot,
    ...buildEnv,
  };

  // outDir/buildRoot are read back OUT of baseEnv at call time, not closed over. That is
  // what gives `perturb` a real lever: the only way to show this gate can go red against
  // two REAL builds (rather than a synthetic fixture) is to reintroduce an actual source of
  // nondeterminism between them, and "the build was told it lives somewhere else" is one
  // this repo already knows bakes into the objects.
  const phase = (label) => {
    fs.rmSync(baseEnv.CLODE_TJS_BUILD, { recursive: true, force: true });
    log(`build ${label}: starting`);
    const r = runEngineBuild({ env: baseEnv, timeoutMs });
    if (!r.ok) {
      throw new Error(`${label} engine build FAILED (status ${r.status}; success marker `
        + `${/\(tjs-shim-ok\)/.test(r.stdout) ? 'present' : 'ABSENT'}):\n`
        + `${r.stdout.slice(-4000)}\n${r.stderr.slice(-4000)}`);
    }
    log(`build ${label}: ok in ${(r.wallMs / 1000).toFixed(1)}s`);
    const snap = snapshotPhase(label, findBuildDir(baseEnv.CLODE_TJS_BUILD),
      path.join(baseEnv.CLODE_TJS_OUT, 'tjs'), snapshotsRoot);
    return { ...snap, wallMs: r.wallMs };
  };

  const a = phase('a');
  if (perturb) perturb({ tree, outDir, buildRoot, baseEnv });
  const b = phase('b');

  // Identical basenames by construction: both snapshots are named `tjs`, in different
  // directories. compareArtifacts refuses anything else, so this cannot silently rot.
  const cmp = compareArtifacts(a.enginePath, b.enginePath);

  // Object grain, only when the whole binary already differs: it localises a divergence
  // to a translation unit instead of saying "differs, somewhere". Free when identical
  // (skipped), and the only useful output when not.
  let differingObjects = null;
  if (!cmp.identical) {
    differingObjects = [];
    const { sha256OfSync } = require('./engine-build-harness.cjs');
    for (const rel of a.objects) {
      if (!b.objects.includes(rel)) { differingObjects.push(`${rel}: MISSING from build b`); continue; }
      const hA = sha256OfSync(path.join(a.objDir, rel));
      const hB = sha256OfSync(path.join(b.objDir, rel));
      if (hA !== hB) differingObjects.push(`${rel}: ${hA.slice(0, 12)} vs ${hB.slice(0, 12)}`);
    }
  }

  return {
    leg: legName,
    identical: cmp.identical,
    sha256: cmp.identical ? cmp.sha : null,
    shaA: cmp.shaA,
    shaB: cmp.shaB,
    bytes: cmp.sizeA,
    sizeB: cmp.sizeB,
    firstDifferingOffset: cmp.firstDifferingOffset,
    differingBytes: cmp.differingBytes,
    differingObjects,
    objectCount: a.objects.length,
    config: describeConfig(baseEnv),
    wallMsA: a.wallMs,
    wallMsB: b.wallMs,
    workDir: dir,
    summary: cmp.summary,
  };
}

module.exports = { doubleBuildEngine, legBuildEnv, describeConfig };

// ---- CLI -----------------------------------------------------------------------------

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--leg') args.leg = argv[++i];
    else if (a === '--keep') args.keep = true;
    else if (a === '--json') args.json = true;
    else return usage(`unknown argument '${a}'`);
  }
  if (!args.leg) return usage('--leg is required');

  // The leg is NAMED, never inferred from the host. A runner that guesses "I am on darwin
  // arm64 so this must be darwin-arm64" would happily label a cross-built or
  // differently-configured engine with a leg it is not, and this repo's whole complaint
  // about verdicts is that they must be trustworthy.
  const { legsFor } = await import('../scripts/tjs-legs.mjs');
  const all = new Map();
  for (const tier of ['release', 'ci']) for (const l of legsFor(tier)) all.set(l.leg, l);
  const leg = all.get(args.leg);
  if (!leg) {
    return usage(`unknown leg '${args.leg}'. Known: ${[...all.keys()].sort().join(', ')}`);
  }

  const { VERDICTS, judgeObservation } = require('./repro-verdicts.cjs');
  const log = (m) => process.stderr.write(`repro-double-build: ${m}\n`);
  const obs = doubleBuildEngine({ legName: leg.leg, buildEnv: legBuildEnv(leg), log });
  if (!args.keep) fs.rmSync(obs.workDir, { recursive: true, force: true });

  if (args.json) process.stdout.write(`${JSON.stringify(obs, null, 2)}\n`);
  const judgement = judgeObservation(VERDICTS[leg.leg], obs);
  process.stdout.write(`repro-double-build: ${leg.leg}: ${obs.summary}\n`);
  process.stdout.write(`repro-double-build: config ${obs.config}, ${obs.objectCount} objects, `
    + `${(obs.wallMsA / 1000).toFixed(1)}s + ${(obs.wallMsB / 1000).toFixed(1)}s\n`);
  process.stdout.write(`repro-double-build: ${judgement.ok ? 'OK' : 'FINDING'} — ${judgement.message}\n`);
  return judgement.ok ? 0 : 1;
}

function usage(why) {
  process.stderr.write(`repro-double-build: ${why}\n`
    + 'usage: node test/repro-double-build.cjs --leg <leg-name> [--json] [--keep]\n');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`repro-double-build: ${err && err.stack || err}\n`); process.exitCode = 1; });
}

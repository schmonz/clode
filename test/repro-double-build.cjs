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
  countObjectsWrittenSince, ENGINE_BUILD_TIMEOUT_MS, REPO,
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

// ---- THE WORK-COUNT FLOOR ---------------------------------------------------------------
//
// THE RULE, taken from the behavioral-gate-harness design shelved in BACKLOG.md: a gate
// that measures "doing X twice gives the same result" must assert that X RAN TWICE.
//
// THIS GATE WAS ALREADY FOUND VACUOUS ONCE. It leaked PATH and HOME into the child and
// never opted out of ccache, so phase B was served entirely from the cache phase A warmed:
// neither phase re-ran the compiler, the whole-binary compare passed trivially, and the
// verdict read `reproducible` while checking nothing but the link. CLODE_TJS_CCACHE=0
// below closed THAT hole. It did not close the class: a build dir the wipe missed, a cmake
// re-configure that generates nothing, a `--target` that builds one file, or a findBuildDir
// that lands on a stale tree all empty this gate exactly as completely, and every one of
// them still ends in `identical`. So the emptiness is MEASURED, not argued away.
//
// WHAT IS COUNTED, and why it is the honest unit: object files under the phase's own build
// dir whose mtime is at or after a marker file stamped immediately before the build was
// spawned. Not compiler invocations — nothing here sees the compiler's process table, and
// counting ninja's edges means parsing its log, a second and driftable notion of the same
// fact. An object written during the phase is the product of a compile that happened, and
// it is the very artifact whose bytes the comparison is about.
//
// TWO RULES, because either alone is empty:
//   SELF-SCALING  every object present must have been written by THIS phase. No magic
//                 number, so a lean leg with 180 objects and a fat one with 372 are both
//                 held to their own whole build. This is what catches an inherited tree.
//   ABSOLUTE      and at least WORK_FLOOR of them, because "wrote all zero of its zero
//                 objects" satisfies the first rule perfectly. This is what catches a
//                 build dir the harness pointed at the wrong place.
//
// 50 is chosen to be far below every real leg (the leanest engine config here compiles
// well over a hundred translation units) and far above any number a broken build produces.
// It is a floor under a floor, not a threshold anyone should tune.
const WORK_FLOOR = 50;

// PURE. '' when the phase did enough real work for its bytes to mean something, otherwise
// the reason it did not — which the caller must carry all the way to the verdict, because
// an insufficient-work run is neither a pass nor a reproducibility failure.
function assessPhaseWork({ label, objectCount, written, floor = WORK_FLOOR }) {
  if (written < floor) {
    return `phase ${label} wrote ${written} of ${objectCount} object file(s), below the `
      + `floor of ${floor}: this build did not compile, so comparing its bytes measures `
      + 'nothing. A double-build gate that cannot see the compiler run is the vacuous gate '
      + 'this floor exists to refuse.';
  }
  if (written < objectCount) {
    return `phase ${label} wrote ${written} of ${objectCount} object file(s) — the rest `
      + 'were INHERITED, not compiled. Two builds that share objects agree about those '
      + 'objects by construction, which is not the property this gate claims to measure.';
  }
  return '';
}

// PURE, and exported so the one env fact this gate's MEANING depends on can be asserted
// without paying for two engine builds.
//
// THE GATE THAT COULD NOT FAIL, and why CLODE_TJS_CCACHE=0 is here. This file's own header
// names the property: "a cache that returns a different object than a fresh compile is the
// one failure mode that matters". PATH and HOME are passed through to the child, so on any
// box with ccache installed -- this developer box since scripts/ccache-launcher.cjs's task
// 2, and now, potentially, a CI runner, since .github/actions/build-leg installs one --
// scripts/build-tjs.cjs enables the launcher and phase B is served ENTIRELY from the cache
// phase A warmed. Neither phase re-runs the compiler, the whole-binary compare passes
// trivially, and the only nondeterminism still reachable is in the LINK. The verdict would
// keep reading `reproducible` while checking almost nothing.
//
// LAST, AFTER the `...buildEnv` spread, unlike every other key here. The leg knobs are a
// caller seam on purpose (legBuildEnv derives them from the manifest); this is not a knob
// but the precondition that makes the measurement mean anything, and a leg config that
// could switch it back on could silently empty the gate. `perturb` remains the seam for
// showing this gate CAN go red.
function doubleBuildEnv({ vendorParent, outDir, buildRoot, buildEnv = {} }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLODE_TJS_VENDOR: vendorParent,
    CLODE_TJS_OUT: outDir,
    CLODE_TJS_BUILD: buildRoot,
    ...buildEnv,
    CLODE_TJS_CCACHE: '0',
  };
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
  const baseEnv = doubleBuildEnv({ vendorParent, outDir, buildRoot, buildEnv });

  // outDir/buildRoot are read back OUT of baseEnv at call time, not closed over. That is
  // what gives `perturb` a real lever: the only way to show this gate can go red against
  // two REAL builds (rather than a synthetic fixture) is to reintroduce an actual source of
  // nondeterminism between them, and "the build was told it lives somewhere else" is one
  // this repo already knows bakes into the objects.
  const phase = (label) => {
    fs.rmSync(baseEnv.CLODE_TJS_BUILD, { recursive: true, force: true });
    // The work-count marker, written HERE and read back for its own mtime rather than
    // trusting Date.now(): the comparison is filesystem-timestamp against
    // filesystem-timestamp, so a stepped clock or a coarse-granularity mount cannot make a
    // phase that did nothing look busy (or the reverse).
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, `work-marker-${label}`);
    fs.writeFileSync(marker, label);
    const since = fs.statSync(marker).mtimeMs;
    log(`build ${label}: starting`);
    const r = runEngineBuild({ env: baseEnv, timeoutMs });
    if (!r.ok) {
      throw new Error(`${label} engine build FAILED (status ${r.status}; success marker `
        + `${/\(tjs-shim-ok\)/.test(r.stdout) ? 'present' : 'ABSENT'}):\n`
        + `${r.stdout.slice(-4000)}\n${r.stderr.slice(-4000)}`);
    }
    log(`build ${label}: ok in ${(r.wallMs / 1000).toFixed(1)}s`);
    // BEFORE snapshotPhase copies them: fs.copyFileSync does not preserve mtime, so the
    // snapshot's objects all look freshly written no matter what the build did.
    const realBuildDir = findBuildDir(baseEnv.CLODE_TJS_BUILD);
    const written = countObjectsWrittenSince(realBuildDir, since);
    const snap = snapshotPhase(label, realBuildDir,
      path.join(baseEnv.CLODE_TJS_OUT, 'tjs'), snapshotsRoot);
    const work = { objects: snap.objects.length, written };
    log(`build ${label}: compiled ${written} of ${work.objects} objects`);
    return { ...snap, wallMs: r.wallMs, work };
  };

  const a = phase('a');
  if (perturb) perturb({ tree, outDir, buildRoot, baseEnv });
  const b = phase('b');

  // THE FLOOR, BEFORE the comparison is allowed to mean anything. Both phases, because a
  // gate that checked only the second would still pass a run whose FIRST build was empty.
  const insufficientWork = [
    assessPhaseWork({ label: 'a', objectCount: a.work.objects, written: a.work.written }),
    assessPhaseWork({ label: 'b', objectCount: b.work.objects, written: b.work.written }),
  ].filter(Boolean).join(' ') || null;

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
    work: { a: a.work, b: b.work },
    insufficientWork,
    config: describeConfig(baseEnv),
    wallMsA: a.wallMs,
    wallMsB: b.wallMs,
    workDir: dir,
    summary: cmp.summary,
  };
}

module.exports = {
  doubleBuildEngine, doubleBuildEnv, legBuildEnv, describeConfig,
  assessPhaseWork, WORK_FLOOR,
};

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

  const { VERDICTS, judgeObservation, nonNativeMechanism } = require('./repro-verdicts.cjs');
  // BEFORE two engine builds, not after: this runner builds NATIVELY on the job host, so a
  // leg whose engine is really produced inside a VM, an alpine container, an osxcross image
  // or a qemu bake would be measured as the HOST's engine and recorded under that leg's
  // name. An untrue verdict is worse than no verdict.
  const mech = nonNativeMechanism(leg);
  if (mech) {
    return usage(`leg '${leg.leg}' declares '${mech}', so its engine is not built natively `
      + 'on this host. Double-building here would measure THIS machine\'s engine and label '
      + `it '${leg.leg}'. Measuring it needs the double-build driven inside that leg's own `
      + 'build mechanism (.github/actions/build-leg), which this runner does not do.');
  }
  if (!VERDICTS[leg.leg]) {
    return usage(`leg '${leg.leg}' has no entry in test/repro-verdicts.cjs, so there would `
      + 'be nothing to judge the result against');
  }
  const log = (m) => process.stderr.write(`repro-double-build: ${m}\n`);
  const obs = doubleBuildEngine({ legName: leg.leg, buildEnv: legBuildEnv(leg), log });
  if (!args.keep) fs.rmSync(obs.workDir, { recursive: true, force: true });

  if (args.json) process.stdout.write(`${JSON.stringify(obs, null, 2)}\n`);
  const judgement = judgeObservation(VERDICTS[leg.leg], obs);
  process.stdout.write(`repro-double-build: ${leg.leg}: ${obs.summary}\n`);
  process.stdout.write(`repro-double-build: config ${obs.config}, ${obs.objectCount} objects, `
    + `${(obs.wallMsA / 1000).toFixed(1)}s + ${(obs.wallMsB / 1000).toFixed(1)}s\n`);
  process.stdout.write(`repro-double-build: work a=${obs.work.a.written}/${obs.work.a.objects} `
    + `b=${obs.work.b.written}/${obs.work.b.objects} objects compiled (floor ${WORK_FLOOR})\n`);
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

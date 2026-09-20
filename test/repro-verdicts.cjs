'use strict';
// PER-LEG REPRODUCIBILITY VERDICTS — the machine-checked version of a standing bar that
// until now lived in BACKLOG.md prose and in one person's head:
//
//     ccache is not "done" until every leg has a reproducibility verdict.
//
// A cache that returns a different object than a fresh compile is the one failure mode
// that matters, and "build twice, compare the whole binary" is the only check that catches
// it without trusting the cache's own accounting. test/repro-double-build.cjs does the
// building; this file records what each of the 44 legs is KNOWN to do, what that knowledge
// rests on, and refuses to let a leg quietly lose ground.
//
// WHAT THIS FILE IS NOT. It is not a to-do list of 40 legs that must all go green, and it
// is not a claim that the fleet is reproducible. It is an honest census: two legs measured,
// two measured and failing, forty never looked at — with the REASON each one has not been
// looked at written down, because "unproven" with no reason reads as "not got round to it"
// and sends the next person to run a four-hour job nobody was ever going to schedule.
//
// THREE STATES, and the ranking is the design:
//
//     unproven  <  known-not-reproducible  <  reproducible
//
// KNOWING a leg is broken outranks never having looked. A `known-not-reproducible` entry
// carries the reason and the named fix, which is what stops the question being re-derived
// from scratch next quarter — exactly what happened to the NetBSD archive question, asked
// and half-answered twice before anyone measured it.
//
// GRAIN IS A SEPARATE FIELD, and that is the rule that keeps this file trustworthy. NetBSD
// has a real, measured, live-guest determinism result — at ARCHIVE grain (`ar qcD` +
// `ranlib -D`, two runs, identical). That is not an engine verdict, and recording it as one
// would be the first lie. `reproducible` REQUIRES grain `whole-binary`.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');

const REPRODUCIBLE = 'reproducible';
const KNOWN_NOT_REPRODUCIBLE = 'known-not-reproducible';
const UNPROVEN = 'unproven';
const VERDICT_RANK = { [UNPROVEN]: 0, [KNOWN_NOT_REPRODUCIBLE]: 1, [REPRODUCIBLE]: 2 };

// What was actually compared. `whole-binary` is the only grain that earns `reproducible`.
const GRAINS = ['whole-binary', 'object', 'archive', 'mechanism', 'none'];

// Where the double-build for this leg actually runs. `none` is not a shrug — it is the
// honest label for a leg too expensive to double-build anywhere today, and the manifest
// requires the cost to be stated in that leg's `because`.
const CADENCES = ['weekly', 'on-demand', 'none'];

// ---- shorthands, so 33 near-identical entries stay readable without becoming derived ---
//
// Each leg still gets its own literal entry (this is a census; a loop over a name list
// would make it a rule). These only share the SHAPE.
const tooSlow = (because) => ({ verdict: UNPROVEN, grain: 'none', cadence: 'none', because });

const VM_GUEST = 'too slow to double-build in CI: a cross-platform-actions VM guest, where '
  + 'the engine build is the bulk of a 20-300 minute job and doubling it doubles that';
const NETBSD_CROSS = 'too slow to double-build in CI: a tier-2 leg that builds a whole '
  + 'NetBSD cross-toolchain from source before it compiles anything (75-113 minutes '
  + 'measured, run 33959009299); netbsd-mips64eb took 115 minutes on its last cold run, so '
  + 'double-building it is ~4 hours';
const QEMU_USER = 'too slow to double-build in CI: an alpine/musl leg built under qemu-user '
  + 'emulation (timeout 300, smoke reduced to --version for the same reason)';

const VERDICTS = {
  // ======================================================================================
  // REPRODUCIBLE — measured, whole-binary, twice. Two legs. That is the whole list.
  // ======================================================================================

  'darwin-arm64': {
    verdict: REPRODUCIBLE, grain: 'whole-binary', cadence: 'weekly',
    proofs: [{
      sha256: '559224b931dd9a658b14aee1606f8c0c3a05a6078e4ddb09c1b171082f723877',
      bytes: 5_464_448, date: '2026-09-20',
      config: 'wasm/mimalloc/ffi at build-tjs defaults, as the leg ships',
      where: 'host darwin/arm64 (Darwin 27), two full builds 76.2s + 48.6s, 372 objects, '
        + 'via test/repro-double-build.cjs --leg darwin-arm64',
    }],
    evidence: 'Two causes were found and fixed before this could hold, both platform-'
      + "neutral: mimalloc's __DATE__/__TIME__ banner (an anchored source fixup in "
      + 'scripts/build-tjs.cjs, chosen over -D__DATE__= because that is a gcc/clang '
      + 'spelling MSVC rejects), and Apple ar/libtool stamping member mtimes into 14 static '
      + 'archives, which ld64 folds into LC_UUID (ZERO_AR_DATE=1, the cctools lever and only '
      + "that). CORRECTION carried forward: ld64's LC_UUID is a CONTENT hash, not a "
      + 'per-link nonce — differing UUIDs were a symptom, never a cause.',
  },

  'linux-x64-glibc': {
    verdict: REPRODUCIBLE, grain: 'whole-binary', cadence: 'weekly',
    proofs: [
      { sha256: '648221ea', bytes: 7_531_360, date: '2026-09-19',
        config: 'WASM off',
        where: 'ubuntu:26.04 container, gcc 15.2, glibc 2.43, same CLODE_TJS_OUT, two full '
          + 'engine builds' },
      { sha256: 'fc3608dc', bytes: 8_191_584, date: '2026-09-19',
        config: 'WASM on — the RELEASE config, WAMR 2.4.4 confirmed compiled',
        where: 'ubuntu:26.04 container, gcc 15.2, glibc 2.43, same CLODE_TJS_OUT, two full '
          + 'engine builds' },
    ],
    evidence: 'Reproducible with NO extra flags, proven twice — once with WASM off and once '
      + "with it on, because the first proof had turned WAMR off for time and the leg ships "
      + "it on. Debian/Ubuntu's binutils is packaged --enable-deterministic-archives, so "
      + 'ZERO_AR_DATE and ar -D are both no-ops here: the darwin fix is inert, not '
      + 'corrective. GNU ld output is stable and the build-id is content-derived. NOTE the '
      + 'sha256 values are 8-character prefixes — that is all BACKLOG.md recorded, and '
      + 'inventing 56 more characters to satisfy a format would be worse than a prefix.',
    caveat: "The leg's documented release os (ubuntu-22.04) does not build at all today "
      + '(mod_spawn_sync.c trips -Werror=implicit-function-declaration on '
      + '_GNU_SOURCE-gated posix_spawn_file_actions_addchdir_np); ci-os overrides to '
      + 'ubuntu-26.04, which is what was measured. This verdict covers the CI os, not the '
      + 'documented release floor.',
  },

  // ======================================================================================
  // KNOWN-NOT-REPRODUCIBLE — measured to fail, with the reason and the named fix.
  // ======================================================================================
  //
  // Both Windows legs, and the grain is `mechanism`: nobody has double-built a Windows
  // engine (no Windows hardware here, and the harness's find/cp use is unproven on that
  // runner). What IS measured is stronger than a guess and weaker than a binary diff —
  // the deterministic archive rules this repo composes NEVER REACH the archiver that runs.

  'windows-amd64': {
    verdict: KNOWN_NOT_REPRODUCIBLE, grain: 'mechanism', cadence: 'on-demand',
    measured: '2026-09-20',
    reason: 'scripts/ar-determinism.cjs probes PATH, finds mingw\'s GNU ar at '
      + 'C:\\mingw64\\bin\\ar.EXE, and it accepts -D — so the leg logs '
      + '`ar-determinism: FLAGS`. But the leg is msvc:true and build-tjs.cjs configures it '
      + '-G Ninja -DCMAKE_C_COMPILER=cl, so cmake loads Windows-MSVC.cmake, which sets '
      + 'CMAKE_C_CREATE_STATIC_LIBRARY — documented to OVERRIDE '
      + 'CMAKE_C_ARCHIVE_CREATE/APPEND/FINISH. The archives are built by lib.exe, which has '
      + 'no -D, and the deterministic rules were composed for an archiver that never ran. '
      + 'The leg\'s own `ar-determinism: WARNING` line says so verbatim.',
    wouldFix: 'lib.exe has no -D. The MSVC levers are link.exe /Brepro (which zeroes the PE '
      + "TimeDateStamp and the debug directory's timestamp) plus lib.exe's own determinism; "
      + '/Brepro appears NOWHERE in this repo. Landing it means pushing it through '
      + 'CMAKE_EXE_LINKER_FLAGS for the MSVC legs only — and scripts/ar-determinism.cjs is '
      + 'engine-recipe source, so touching it rebuilds all 44 legs.',
    evidence: 'CI run 35487107745, both publisher legs: `build-tjs: ar-determinism: WARNING '
      + 'probed C:\\mingw64\\bin\\ar.EXE but cmake chose .../MSVC/14.51.36231/bin/Hostx64/'
      + 'x64/lib.exe (state=flags source=path) -- the archive-rule decision was made about a '
      + 'different archiver`. Reproduced as a MECHANISM on a darwin host: a configure handed '
      + '-DCMAKE_C_CREATE_STATIC_LIBRARY inherits both archive rules into the subproject '
      + 'scope and still generates a command with no qcD in it.',
  },

  'windows-arm64': {
    verdict: KNOWN_NOT_REPRODUCIBLE, grain: 'mechanism', cadence: 'on-demand',
    measured: '2026-09-20',
    reason: 'Same as windows-amd64: the ar-determinism probe finds mingw ar and accepts -D, '
      + 'cmake then chooses MSVC lib.exe, and the rules reach CMakeCache.txt and nothing '
      + 'else. Both publisher legs of CI run 35487107745 printed the same WARNING.',
    wouldFix: 'Same as windows-amd64: link.exe /Brepro, which appears nowhere in this repo.',
    evidence: 'CI run 35487107745, the windows-arm64 leg, same FLAGS + WARNING pair as its '
      + 'amd64 twin.',
  },

  // ======================================================================================
  // UNPROVEN — never measured. Each says WHY, because a bare "unproven" is a to-do nobody
  // can price.
  // ======================================================================================

  // ---- native runners, cheap, simply not scheduled yet ---------------------------------
  'linux-arm64-glibc': {
    verdict: UNPROVEN, grain: 'none', cadence: 'weekly',
    because: 'never measured, but CHEAP: a native ubuntu-26.04-arm runner, same toolchain '
      + 'family as linux-x64-glibc. It is in the weekly schedule, so the next scheduled run '
      + 'is what promotes or fails it.',
  },
  'linux-x64-musl': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. Cheap (an alpine container on a native x64 runner, 8-9 minute '
      + 'job) and it IS a published artifact, so it is the strongest candidate for the next '
      + 'promotion to weekly. Left on-demand in this pass only because the scheduled '
      + 'workflow starts with the three legs whose runners need no container step.',
  },
  'linux-arm64-musl': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. Same shape and same argument as linux-x64-musl, on the native '
      + 'arm runner.',
  },
  'linux-x86-musl': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. An alpine x86 container on an x64 runner, so no emulation and '
      + 'no VM — cheap enough to run on demand.',
  },

  // ---- darwin cross legs: cheap-ish, but each drags a container image ------------------
  'darwin-x64': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. Cross-built on ubuntu through the ci/osxcross-darwin image, '
      + 'no-exec, so the binary can be byte-compared but not run. The two darwin fixes are '
      + 'platform-neutral and the archiver here is cctools (x86_64-apple-darwin10-ar, which '
      + 'reads ZERO_AR_DATE), so this is EXPECTED to pass — expected is not measured.',
  },
  'darwin-x86': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. Same osxcross image and same cctools archiver as darwin-x64, '
      + 'at the 10.4/i386 floor.',
  },
  'darwin-ppc': {
    verdict: UNPROVEN, grain: 'none', cadence: 'on-demand',
    because: 'never measured. Cross-built through a pinned gcc-powerpc-apple-darwin8 image; '
      + 'no-exec. Its archiver has never been probed for real (BACKLOG: "the cross legs\' '
      + 'archivers have never been probed"), so its verdict is genuinely open, not assumed.',
  },

  // ---- VM guests: the engine build IS the job -----------------------------------------
  'netbsd-amd64': tooSlow(`${VM_GUEST}. NetBSD specifically has an ARCHIVE-grain result `
    + '(GNU ar (NetBSD Binutils nb1) 2.42 is NOT deterministic; ar qcD + ranlib -D IS, '
    + 'measured on a live 11.0_RC2 guest and shipped via scripts/ar-determinism.cjs) — that '
    + 'is an archive fact, NOT an engine verdict, and this field is why the two cannot be '
    + 'confused.'),
  'netbsd-arm64': tooSlow(`${VM_GUEST} (timeout 300: arm64 under TCG).`),
  'freebsd-amd64': tooSlow(VM_GUEST),
  'freebsd-arm64': tooSlow(`${VM_GUEST} (timeout 300: arm64 under TCG).`),
  'openbsd-amd64': tooSlow(VM_GUEST),
  'openbsd-arm64': tooSlow(`${VM_GUEST} (timeout 300: arm64 under TCG).`),
  'dragonflybsd-amd64': tooSlow(VM_GUEST),
  'midnightbsd-amd64': tooSlow(VM_GUEST),
  'haiku-x64': tooSlow(`${VM_GUEST}. Also carries an open engine bug of its own (the tjs `
    + 'async write deadlock for >64KB to a pipe), so a red here would need disentangling '
    + 'before it could be read as a reproducibility finding.'),
  'omnios-amd64': tooSlow(VM_GUEST),
  'openindiana-amd64': tooSlow(`${VM_GUEST} (timeout 120).`),
  'solaris-amd64': tooSlow(`${VM_GUEST} (timeout 120).`),

  // ---- qemu-user musl legs -------------------------------------------------------------
  'linux-s390x-musl': tooSlow(QEMU_USER),
  'linux-armv7-musl': tooSlow(QEMU_USER),
  'linux-ppc64le-musl': tooSlow(QEMU_USER),
  'linux-riscv64-musl': tooSlow(QEMU_USER),
  'linux-loongarch64-musl': tooSlow(QEMU_USER),

  // ---- tier-2 cross legs: a toolchain build before a source file is touched ------------
  'linux-riscv64': tooSlow('too slow to double-build in CI: a tier-2 debian:trixie cross leg '
    + 'with a 1800-minute timeout and qemu-user verification, currently soft-fail.'),
  'linux-s390x': tooSlow('too slow to double-build in CI: a tier-2 debian:trixie cross leg '
    + 'with a 1800-minute timeout and qemu-user verification, currently soft-fail.'),
  'netbsd-sparc': tooSlow('too slow to double-build in CI: the engine is baked INSIDE a '
    + 'qemu NetBSD/sparc guest (spike/quickjs/qemu/ci-guest-bake.sh, timeout 3600) and then '
    + 'cross-fused on the x64 host. Doubling the bake is the whole cost of the leg, twice.'),
  'netbsd-m68k': tooSlow(NETBSD_CROSS),
  'netbsd-sparc64': tooSlow(NETBSD_CROSS),
  'netbsd-alpha': tooSlow(NETBSD_CROSS),
  'netbsd-hppa': tooSlow(NETBSD_CROSS),
  'netbsd-macppc': tooSlow(NETBSD_CROSS),
  'netbsd-pmax': tooSlow(NETBSD_CROSS),
  'netbsd-sgimips': tooSlow(NETBSD_CROSS),
  'netbsd-i386': tooSlow(NETBSD_CROSS),
  'netbsd-earmv7hf': tooSlow(NETBSD_CROSS),
  'netbsd-riscv64': tooSlow(NETBSD_CROSS),
  'netbsd-mips64eb': tooSlow(`${NETBSD_CROSS} — this is the leg the 115-minute figure was `
    + 'measured on.'),
  'netbsd-sh3el': tooSlow(NETBSD_CROSS),
  'cosmo': tooSlow('too slow to double-build in CI: an APE cross leg with a 3600-minute '
    + 'timeout, built through the cosmocc toolchain. Its patches are engine sources that '
    + 'have their own history of silently not applying, so a verdict here would be valuable '
    + '— it is a cost problem, not a priority problem.'),
};

// ---- the recorded baselines — the ONLY deliberate edit that moves a leg's ground -------
//
// Same idiom as UNMIGRATED_BASELINE / UNCONTROLLED_GATE_BASELINE in
// test/guards-population.cjs, with the direction flipped where the direction is flipped:
// reproducible legs are meant to go UP, unproven legs are meant to go DOWN, and the ratchet
// calls out movement the GOOD way too, so progress cannot quietly leave the baseline stale.
//
// MEASURED 2026-09-20: 44 legs — 2 reproducible, 2 known-not-reproducible, 40 unproven.
const REPRODUCIBLE_BASELINE = 2;
const UNPROVEN_BASELINE = 40;

function countByVerdict(verdicts) {
  const counts = { [REPRODUCIBLE]: 0, [KNOWN_NOT_REPRODUCIBLE]: 0, [UNPROVEN]: 0 };
  for (const v of Object.values(verdicts)) {
    if (counts[v.verdict] === undefined) counts[v.verdict] = 0;
    counts[v.verdict]++;
  }
  return counts;
}

// ---- shape: an entry may not claim more than it measured -------------------------------
//
// PURE: `verdicts` is the already-in-hand manifest object.
function scanManifestShape({ verdicts }) {
  const findings = [];
  let examined = 0;
  const HEX8 = /^[0-9a-f]{8,64}$/;
  for (const [leg, v] of Object.entries(verdicts)) {
    examined++;
    if (VERDICT_RANK[v.verdict] === undefined) {
      findings.push(`${leg}: unknown verdict '${v.verdict}' — the states are `
        + `${Object.keys(VERDICT_RANK).join(', ')}; an unrecognised value must not be `
        + 'tolerated as a fourth, unranked state');
      continue;
    }
    if (!CADENCES.includes(v.cadence)) {
      findings.push(`${leg}: cadence must be one of ${CADENCES.join(', ')} — a verdict `
        + 'nothing ever re-checks is not a gate');
    }
    if (v.grain !== undefined && !GRAINS.includes(v.grain)) {
      findings.push(`${leg}: unknown grain '${v.grain}' (${GRAINS.join(', ')})`);
    }
    if (v.verdict === REPRODUCIBLE) {
      if (v.grain !== 'whole-binary') {
        findings.push(`${leg}: claims ${REPRODUCIBLE} at grain '${v.grain}' — only a `
          + "whole-binary comparison earns that verdict. An archive-grain or object-grain "
          + 'result is real evidence and belongs in `evidence`, but it is not an engine '
          + 'verdict (this is exactly the NetBSD trap).');
      }
      const proofs = Array.isArray(v.proofs) ? v.proofs : [];
      if (proofs.length === 0) {
        findings.push(`${leg}: claims ${REPRODUCIBLE} with no proof entry — a verdict with `
          + 'no sha256, byte count, date and place is prose, and prose is what this file '
          + 'exists to replace');
      }
      for (const [i, p] of proofs.entries()) {
        if (typeof p.sha256 !== 'string' || !HEX8.test(p.sha256)) {
          findings.push(`${leg} proof[${i}]: sha256 must be 8-64 lowercase hex characters, `
            + `got ${JSON.stringify(p.sha256)}`);
        }
        if (!Number.isInteger(p.bytes) || p.bytes <= 0) {
          findings.push(`${leg} proof[${i}]: bytes must be a positive integer — the size is `
            + 'half of what makes a digest checkable by a human');
        }
        for (const field of ['date', 'where', 'config']) {
          if (typeof p[field] !== 'string' || p[field].trim() === '') {
            findings.push(`${leg} proof[${i}]: \`${field}\` must be a non-empty string`);
          }
        }
      }
      if (typeof v.evidence !== 'string' || v.evidence.trim() === '') {
        findings.push(`${leg}: claims ${REPRODUCIBLE} with no \`evidence\` prose`);
      }
    }
    if (v.verdict === KNOWN_NOT_REPRODUCIBLE) {
      for (const field of ['reason', 'wouldFix', 'evidence', 'measured']) {
        if (typeof v[field] !== 'string' || v[field].trim() === '') {
          findings.push(`${leg}: ${KNOWN_NOT_REPRODUCIBLE} requires a non-empty `
            + `\`${field}\` — a recorded failure whose cause or fix is not written down is `
            + 'a question that gets re-derived from scratch');
        }
      }
      if (Array.isArray(v.proofs) && v.proofs.length > 0) {
        findings.push(`${leg}: ${KNOWN_NOT_REPRODUCIBLE} carries \`proofs\` — a proof is a `
          + 'record of byte-identity, which contradicts the verdict');
      }
    }
    if (v.verdict === UNPROVEN) {
      if (typeof v.because !== 'string' || v.because.trim() === '') {
        findings.push(`${leg}: ${UNPROVEN} requires a non-empty \`because\` saying why it `
          + 'has not been measured — a bare "unproven" is a to-do nobody can price');
      }
      if (Array.isArray(v.proofs) && v.proofs.length > 0) {
        findings.push(`${leg}: ${UNPROVEN} carries \`proofs\` — that is a contradiction, `
          + 'not a note; if it was measured, record the verdict it earned');
      }
      if (v.cadence === 'none' && !/too slow|never measured/.test(v.because || '')) {
        findings.push(`${leg}: cadence 'none' with no cost stated in \`because\` — a leg `
          + 'that nothing will ever re-check must say why out loud, or it reads as a silent '
          + 'pass');
      }
    }
  }
  return { findings, examined };
}

// ---- coverage: derived from scripts/tjs-legs.mjs, never hand-listed --------------------

// The leg manifest is ESM and guard read() is synchronous, so it is invoked exactly the way
// .github/workflows/tjs-legs.yml invokes it — as a process, printing JSON. That keeps this
// reading off the SAME single source of truth rather than a second copy of the leg names,
// which is the mistake scripts/tjs-legs.mjs's own header exists to forbid.
function legNamesFromManifest() {
  const names = new Set();
  for (const tier of ['release', 'ci']) {
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/tjs-legs.mjs'), tier],
      { encoding: 'utf8' });
    for (const leg of JSON.parse(out)) names.add(leg.leg);
  }
  return [...names].sort();
}

// PURE.
function scanCoverage({ legNames, verdicts }) {
  const findings = [];
  let examined = 0;
  for (const leg of legNames) {
    examined++;
    if (!verdicts[leg]) {
      findings.push(`${leg}: no reproducibility verdict. Every leg gets one — that is the `
        + 'whole bar. If it cannot be measured, record it `unproven` with the cost as its '
        + '`because`.');
    }
  }
  const known = new Set(legNames);
  for (const leg of Object.keys(verdicts)) {
    examined++;
    if (!known.has(leg)) {
      findings.push(`${leg}: has a reproducibility verdict but is not a leg in `
        + 'scripts/tjs-legs.mjs — a verdict about nothing, left behind by a rename or a '
        + 'retirement');
    }
  }
  return { findings, examined };
}

// ---- the ratchet ------------------------------------------------------------------------
//
// A leg may only move in the improving direction without a DELIBERATE edit to a baseline
// below. Both directions are reported: a fall in `reproducible` (or a rise in `unproven`)
// is a finding, and the opposite is ok but SAYS to re-cut, because leaving improvement
// undetected is how a ratchet starts lying by omission.
function ratchetVerdicts(counts, reproducibleBaseline, unprovenBaseline) {
  const proven = counts[REPRODUCIBLE] || 0;
  const unproven = counts[UNPROVEN] || 0;
  if (proven < reproducibleBaseline) {
    return { ok: false, message: `${proven} leg(s) claim ${REPRODUCIBLE} — BELOW the `
      + `recorded baseline of ${reproducibleBaseline}. A leg was DEMOTED. That is either a `
      + 'real regression (re-measure it and record `known-not-reproducible` with the '
      + 'reason), or someone quietly downgraded a verdict to make a red go away. Lowering '
      + 'REPRODUCIBLE_BASELINE in test/repro-verdicts.cjs is the deliberate edit that '
      + 'allows it, and it wants the measurement recorded beside it.' };
  }
  if (unproven > unprovenBaseline) {
    return { ok: false, message: `${unproven} leg(s) are ${UNPROVEN} — ABOVE the recorded `
      + `baseline of ${unprovenBaseline}. Either a NEW leg arrived with no verdict (measure `
      + 'it, or record the cost as its `because`), or a measured leg was rolled back to '
      + '"never looked at", which throws away evidence someone paid for.' };
  }
  const notes = [];
  if (proven > reproducibleBaseline) {
    notes.push(`${proven} leg(s) now claim ${REPRODUCIBLE}, ABOVE the baseline of `
      + `${reproducibleBaseline}. Progress: raise REPRODUCIBLE_BASELINE to ${proven} so a `
      + 'future demotion is caught at the new, higher bar.');
  }
  if (unproven < unprovenBaseline) {
    notes.push(`${unproven} leg(s) remain ${UNPROVEN}, BELOW the baseline of `
      + `${unprovenBaseline}. Progress: lower UNPROVEN_BASELINE to ${unproven}.`);
  }
  if (notes.length) return { ok: true, message: `re-cut needed — ${notes.join(' ')}` };
  return { ok: true, message: `${proven} ${REPRODUCIBLE}, `
    + `${counts[KNOWN_NOT_REPRODUCIBLE] || 0} ${KNOWN_NOT_REPRODUCIBLE}, ${unproven} `
    + `${UNPROVEN} — matching both recorded baselines` };
}

// ---- judging a REAL observation against a recorded verdict -------------------------------
//
// PURE. `observed` is whatever test/repro-double-build.cjs's doubleBuildEngine() returned.
// This is the half that makes the manifest a GATE rather than a document: a leg recorded
// `reproducible` whose double-build comes back differing is a hard finding.
function judgeObservation(entry, observed) {
  if (!entry) {
    throw new Error('judgeObservation: no reproducibility verdict for this leg. A runner '
      + 'pointed at a leg the manifest has never heard of must STOP — reporting OK for an '
      + 'unknown leg is how a gate covers nothing and says nothing.');
  }
  const detail = observed.summary || (observed.identical ? 'identical' : 'DIFFERS');
  const objs = observed.differingObjects && observed.differingObjects.length
    ? `\n  differing objects:\n${observed.differingObjects.map((o) => `    ${o}`).join('\n')}`
    : '';
  if (entry.verdict === REPRODUCIBLE) {
    if (observed.identical) {
      const known = (entry.proofs || []).some((p) => observed.sha256
        && observed.sha256.startsWith(p.sha256));
      return { ok: true, message: `${REPRODUCIBLE} and still reproducing — ${detail}`
        + (known ? ' (matches a recorded proof)'
          : '. NOTE: this sha matches no recorded proof, which is expected on a different '
          + 'host, toolchain or config — add it as a proof if this is a configuration worth '
          + 'pinning.') };
    }
    return { ok: false, message: `REGRESSION — this leg is recorded ${REPRODUCIBLE} and two `
      + `builds of identical sources produced DIFFERENT bytes. ${detail}${objs}\n  Recorded `
      + `evidence: ${entry.evidence}` };
  }
  if (entry.verdict === KNOWN_NOT_REPRODUCIBLE) {
    if (observed.identical) {
      return { ok: true, message: `recorded ${KNOWN_NOT_REPRODUCIBLE}, but this run was `
        + `IDENTICAL — ${detail}. Re-run to confirm, then promote it: change the verdict to `
        + `${REPRODUCIBLE}, add this as a proof, and raise REPRODUCIBLE_BASELINE.` };
    }
    return { ok: true, message: `${KNOWN_NOT_REPRODUCIBLE}, as recorded — ${detail}. `
      + `Reason: ${entry.reason}` };
  }
  // UNPROVEN
  if (observed.identical) {
    return { ok: true, message: `${UNPROVEN} until now, and this run was IDENTICAL — `
      + `${detail}. Promote it: set the verdict to ${REPRODUCIBLE}, grain whole-binary, add `
      + 'this run as a proof, raise REPRODUCIBLE_BASELINE and lower UNPROVEN_BASELINE.' };
  }
  return { ok: false, message: `${UNPROVEN} until now, and this run DIFFERS — ${detail}`
    + `${objs}\n  This is news, and it is the kind that rots if it is only in a log: record `
    + `it as ${KNOWN_NOT_REPRODUCIBLE} with the reason and what would fix it.` };
}

// ---- the three standing guards -----------------------------------------------------------

const manifestShapeGuard = defineGuard({
  name: 'repro-verdict-manifest-shape',
  read: () => ({ verdicts: VERDICTS }),
  scan: scanManifestShape,
  floor: 44,
  // Every rule at once: an unknown verdict, a reproducible entry with no proof at the wrong
  // grain, a known-not with no reason, and an unproven with no because.
  control: () => ({ verdicts: {
    'a-leg': { verdict: 'probably-fine', cadence: 'weekly' },
    'b-leg': { verdict: REPRODUCIBLE, grain: 'archive', cadence: 'weekly', proofs: [], evidence: '' },
    'c-leg': { verdict: KNOWN_NOT_REPRODUCIBLE, grain: 'mechanism', cadence: 'on-demand' },
    'd-leg': { verdict: UNPROVEN, grain: 'none', cadence: 'none' },
  } }),
});

const coverageGuard = defineGuard({
  name: 'repro-verdict-covers-every-leg',
  read: () => ({ legNames: legNamesFromManifest(), verdicts: VERDICTS }),
  scan: scanCoverage,
  floor: 44,
  // A new leg with no verdict, and a verdict for a leg that no longer exists.
  control: () => ({ legNames: ['darwin-arm64', 'a-brand-new-leg'],
    verdicts: { 'darwin-arm64': VERDICTS['darwin-arm64'], 'a-retired-leg': tooSlow('gone') } }),
});

const ratchetGuard = defineGuard({
  name: 'repro-verdict-ratchet',
  read: () => ({ counts: countByVerdict(VERDICTS),
    reproducibleBaseline: REPRODUCIBLE_BASELINE, unprovenBaseline: UNPROVEN_BASELINE }),
  scan: ({ counts, reproducibleBaseline, unprovenBaseline }) => {
    const r = ratchetVerdicts(counts, reproducibleBaseline, unprovenBaseline);
    // Two facts examined: the reproducible floor and the unproven ceiling.
    return { findings: r.ok ? [] : [r.message], examined: 2 };
  },
  floor: 2,
  // A manifest that lost a reproducible leg: the demotion the ratchet exists to catch.
  control: () => ({ counts: { [REPRODUCIBLE]: 0, [KNOWN_NOT_REPRODUCIBLE]: 2, [UNPROVEN]: 42 },
    reproducibleBaseline: REPRODUCIBLE_BASELINE, unprovenBaseline: UNPROVEN_BASELINE }),
});

module.exports = {
  VERDICTS, REPRODUCIBLE, KNOWN_NOT_REPRODUCIBLE, UNPROVEN, VERDICT_RANK, GRAINS, CADENCES,
  REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE,
  countByVerdict, scanManifestShape, scanCoverage, ratchetVerdicts, judgeObservation,
  legNamesFromManifest,
  manifestShapeGuard, coverageGuard, ratchetGuard,
};

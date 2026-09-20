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
    // WHAT A RECORDED sha256 IS, and is not. It is evidence that TWO BUILDS IN ONE RUN
    // agreed — not a value a future run must re-match. Measured the same day, from the red
    // proof: moving CLODE_TJS_OUT/CLODE_TJS_BUILD between two otherwise identical builds
    // changed 47 of 372 objects and the linked size (5,464,448 -> 5,466,496), and two
    // separate runs of the gate differing ONLY in their mkdtemp suffix (same length,
    // different characters) produced 559224b9... and 5901f0fe... So the build path's
    // CONTENT is baked into the engine. judgeObservation() says so rather than going red on
    // a sha that matches no proof; the stronger "different host, same output" tier needs
    // -ffile-prefix-map, which is supported and used nowhere.
    // THE STRONGER TIER, measured 2026-09-20 — its own FIELD, not a fourth grain. `grain`
    // says WHAT was compared (whole binary); this says UNDER WHICH PERTURBATION it held.
    // Earned by `node test/repro-double-build.cjs --leg darwin-arm64 --perturb path`, which
    // relocates the vendored source tree, the output dir AND the build root between the two
    // phases, to a path of a DIFFERENT LENGTH, and then requires byte-identical output.
    pathIndependent: {
      sha256: '343e67c0af835351dfebb2fe6ff8ec3c155154e978c46799eb4db4f55b24cdcc',
      bytes: 5_438_800, date: '2026-09-20',
      config: 'wasm/mimalloc/ffi at build-tjs defaults, as the leg ships',
      where: 'host darwin/arm64 (Darwin 27), Apple clang 21.0.0, two full builds from two '
        + 'DIFFERENT absolute paths (238.7s), 372 of 372 objects compiled in EACH phase (the '
        + 'work floor), 0 of 372 objects differing, via test/repro-double-build.cjs --leg '
        + 'darwin-arm64 --perturb path. The engine carries 151 /clode/... sentinel paths and '
        + 'ZERO paths from the machine that built it.',
    },
    // REPLACES the fixed-path caveat this entry carried until 2026-09-20, which said the
    // absolute build directory was baked into the objects. That was true and is no longer:
    // the same perturbation that measured 47 of 372 objects differing now measures 0.
    caveat: 'Path independence is proven for THIS HOST and this toolchain, which is not the '
      + 'same as "any two hosts agree": compiler version, libc, SDK and the leg config all '
      + 'still have to match. What is now off the list of things that must match is WHERE '
      + 'the build ran. NOTE the `proofs` sha above is from BEFORE the three fixes below '
      + 'and no longer reproduces — a proof records that two builds agreed on the day, not '
      + 'a value a later run must re-match.',
    evidence: 'Two causes were found and fixed before this could hold, both platform-'
      + "neutral: mimalloc's __DATE__/__TIME__ banner (an anchored source fixup in "
      + 'scripts/build-tjs.cjs, chosen over -D__DATE__= because that is a gcc/clang '
      + 'spelling MSVC rejects), and Apple ar/libtool stamping member mtimes into 14 static '
      + 'archives, which ld64 folds into LC_UUID (ZERO_AR_DATE=1, the cctools lever and only '
      + "that). CORRECTION carried forward: ld64's LC_UUID is a CONTENT hash, not a "
      + 'per-link nonce — differing UUIDs were a symptom, never a cause. THREE MORE causes were '
      + 'found and fixed on 2026-09-20, by running the path perturbation to the END rather '
      + 'than stopping when the flag was accepted: (1) the build path in __FILE__ and in '
      + 'debug info, closed by -ffile-prefix-map (scripts/file-prefix-map.cjs) -- which '
      + 'mapped NOTHING at first, because macOS resolves /var to /private/var and the '
      + 'compiler records the resolved spelling; (2) ld64 s debug map, 46 N_OSO stabs '
      + 'recording every object absolute path, +1016 bytes of string table, closed by '
      + '-Wl,-oso_prefix; (3) mimalloc defining MI_GIT_DESCRIBE from `git describe` run in '
      + 'CMAKE OWN WORKING DIRECTORY, i.e. THIS repo, so every clode commit changed the '
      + 'engine bytes whether or not it touched an engine source, closed by '
      + 'fixupMimallocGitDescribe.',
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
    // cadence on-demand, not weekly, and not none: the runner CAN build this leg natively
    // (msvc on a windows runner is a native build, no container and no guest), so it is
    // reachable by workflow_dispatch today. It is not scheduled because the harness shells
    // out to `find` and `cp`, which have never been exercised on a windows runner — a
    // weekly job whose failure mode is "the script did not start" teaches people to ignore
    // it. Proving those two spawns on windows is what promotes this to weekly.
    reason: 'scripts/ar-determinism.cjs probes PATH, finds mingw\'s GNU ar at '
      + 'C:\\mingw64\\bin\\ar.EXE, and it accepts -D — so the leg logs '
      + '`ar-determinism: FLAGS`. But the leg is msvc:true and build-tjs.cjs configures it '
      + '-G Ninja -DCMAKE_C_COMPILER=cl, so cmake loads Windows-MSVC.cmake, which sets '
      + 'CMAKE_C_CREATE_STATIC_LIBRARY — documented to OVERRIDE '
      + 'CMAKE_C_ARCHIVE_CREATE/APPEND/FINISH. The archives are built by lib.exe, which has '
      + 'no -D, and the deterministic rules were composed for an archiver that never ran. '
      + 'The leg\'s own `ar-determinism: WARNING` line says so verbatim.',
    // PATH INDEPENDENCE IS UNPROVEN HERE TOO, with a reason rather than a silence: cl takes
    // neither -ffile-prefix-map nor the -fdebug-prefix-map/-fmacro-prefix-map pair, so
    // scripts/file-prefix-map.cjs's probe lands this leg in `unsupported` and changes NO
    // argument. Its own lever is /PATHMAP, which appears nowhere in this repo. The leg's
    // `build-tjs: file-prefix-map: NONE ... (this compiler takes neither ...)` line says so
    // on every build, so the gap is visible in the log rather than only here.
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
    wouldFix: 'Same as windows-amd64: link.exe /Brepro, which appears nowhere in this repo. '
      + 'And the same second gap: cl takes neither -ffile-prefix-map nor the older '
      + '-fdebug-prefix-map/-fmacro-prefix-map pair, so the build path stays baked into '
      + 'these objects; /PATHMAP is the MSVC answer and is also unused here.',
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
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured, and the CHEAPEST leg still out of reach — an alpine container '
      + 'on a native x64 runner, an 8-9 minute job, and a PUBLISHED artifact. The blocker is '
      + 'not cost: test/repro-double-build.cjs drives scripts/build-tjs.cjs natively on the '
      + "job host, and this leg's engine is built INSIDE the alpine container. Running it "
      + 'natively would double-build the ubuntu-glibc engine and label it linux-x64-musl. '
      + 'This is the next leg to wire, and wiring it means teaching the runner to drive the '
      + "guest action's build step twice.",
  },
  'linux-arm64-musl': {
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured. Same shape, same blocker and same fix as linux-x64-musl, on '
      + 'the native arm runner: an alpine container the runner does not enter.',
  },
  'linux-x86-musl': {
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured. An alpine x86 container on an x64 runner — no emulation and no '
      + 'VM, so cheap, but the same container boundary as linux-x64-musl.',
  },

  // ---- darwin cross legs: cheap-ish, but each drags a container image ------------------
  'darwin-x64': {
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured. Cross-built on ubuntu INSIDE the ci/osxcross-darwin image, '
      + 'which the runner does not build or enter, so a native double-build here would '
      + 'measure the ubuntu engine. no-exec, but that is no obstacle — bytes compare without '
      + 'running. The two darwin fixes are platform-neutral and the archiver is cctools '
      + '(x86_64-apple-darwin10-ar, which reads ZERO_AR_DATE), so this is EXPECTED to pass. '
      + 'Expected is not measured, which is the whole point of this file.',
  },
  'darwin-x86': {
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured. Same osxcross image, same container boundary and same cctools '
      + 'archiver as darwin-x64, at the 10.4/i386 floor.',
  },
  'darwin-ppc': {
    verdict: UNPROVEN, grain: 'none', cadence: 'none',
    because: 'never measured. Cross-built inside a pinned gcc-powerpc-apple-darwin8 image, '
      + 'the same container boundary as the osxcross legs. Its archiver has never been '
      + 'probed for real (BACKLOG: "the cross legs\' archivers have never been probed"), so '
      + 'its verdict is genuinely open rather than merely unmeasured.',
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
    + 'blobulated on the x64 host. Doubling the bake is the whole cost of the leg, twice.'),
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
    // PATH INDEPENDENCE — the stronger tier, and its own FIELD rather than a fifth grain.
    // `grain` says WHAT was compared; this says UNDER WHICH PERTURBATION the comparison
    // held. Folding the two axes into one enum would make `whole-binary` and
    // `whole-binary-path-independent` two values answering two questions, and the rule that
    // `reproducible` REQUIRES grain `whole-binary` would then need to know both spellings —
    // one forgotten spelling and an archive-grain result claims an engine verdict, which is
    // the trap that rule exists to close.
    if (v.pathIndependent !== undefined) {
      const p = v.pathIndependent;
      if (v.verdict !== REPRODUCIBLE || v.grain !== 'whole-binary') {
        findings.push(`${leg}: carries \`pathIndependent\` without ${REPRODUCIBLE} at grain `
          + 'whole-binary underneath it. The stronger property implies the weaker one — two '
          + 'builds at DIFFERENT paths agreeing means two builds at the SAME path agree too '
          + '— so claiming it alone is a verdict smuggled in through a side door.');
      }
      if (typeof p.sha256 !== 'string' || !HEX8.test(p.sha256)) {
        findings.push(`${leg} pathIndependent: sha256 must be 8-64 lowercase hex characters, `
          + `got ${JSON.stringify(p && p.sha256)}`);
      }
      if (!Number.isInteger(p.bytes) || p.bytes <= 0) {
        findings.push(`${leg} pathIndependent: bytes must be a positive integer`);
      }
      for (const field of ['date', 'where', 'config']) {
        if (typeof p[field] !== 'string' || p[field].trim() === '') {
          findings.push(`${leg} pathIndependent: \`${field}\` must be a non-empty string — a `
            + 'record of the stronger tier owes at least as much as an ordinary proof');
        }
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
// The CI MATRIX, derived from the `cadence` field rather than retyped into YAML.
// Promoting a leg from on-demand to weekly is then a one-word edit HERE, in the same file
// that records why it was not scheduled — not an edit in a workflow that has no idea what
// a verdict is. `os` comes from the CI tier of scripts/tjs-legs.mjs, so a leg scheduled
// here runs on the same runner image its per-push build does.
// WHAT THE RUNNER CAN ACTUALLY MEASURE, and the lie it would otherwise tell.
// test/repro-double-build.cjs drives scripts/build-tjs.cjs NATIVELY on whatever host the
// job runs on. It does not start a cross-platform-actions VM, does not enter an alpine
// container, does not build an osxcross image, and does not bake inside a qemu guest —
// every one of which is how some leg's engine is really produced. Point the runner at
// netbsd-m68k on an ubuntu box and it will happily double-build the UBUNTU engine and
// label the verdict `netbsd-m68k`. That is precisely the class of untrue verdict this
// manifest exists to prevent, so it is a refusal, keyed on the leg record's own
// orchestration fields rather than on a hand-kept list of leg names.
const CROSS_FIELDS = ['guest-platform', 'cross-file', 'cross-image', 'cross-dockerfile',
  'netbsd-src', 'cosmo'];

function nonNativeMechanism(rec) {
  for (const f of CROSS_FIELDS) if (rec[f]) return f;
  return null;
}

function ciLegRecords() {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/tjs-legs.mjs'), 'ci'],
    { encoding: 'utf8' });
  return new Map(JSON.parse(out).map((l) => [l.leg, l]));
}

function matrixForLegs(names, why) {
  const byName = ciLegRecords();
  return [...names].sort().map((leg) => {
    if (!VERDICTS[leg]) {
      throw new Error(`${why}: '${leg}' has no reproducibility verdict — a scheduled run `
        + 'would spend two engine builds and then have nothing to judge the result against');
    }
    const rec = byName.get(leg);
    if (!rec) {
      throw new Error(`${why}: leg '${leg}' is not in the CI tier of scripts/tjs-legs.mjs, `
        + 'so there is no runner image to schedule it on. Either add it to the ci tier or '
        + 'run it by hand.');
    }
    const mech = nonNativeMechanism(rec);
    if (mech) {
      throw new Error(`${why}: leg '${leg}' declares '${mech}', so its engine is NOT built `
        + 'natively on the job host. test/repro-double-build.cjs would double-build the '
        + "HOST's engine and label the verdict '" + leg + "' — an untrue verdict, which is "
        + 'worse than no verdict. Measuring it needs the double-build driven inside that '
        + "leg's own build mechanism (see .github/actions/build-leg), which this gate does "
        + 'not do yet.');
    }
    return { leg, os: rec.os };
  });
}

function matrixFor(cadence) {
  const names = Object.entries(VERDICTS).filter(([, v]) => v.cadence === cadence).map(([k]) => k);
  return matrixForLegs(names, `matrixFor(${cadence})`);
}

function scanCoverage({ legNames, verdicts, ciRecords }) {
  const findings = [];
  let examined = 0;
  // A SCHEDULED verdict must be one the runner can honestly produce. A leg whose engine is
  // built inside a VM, a container, a cross image or a qemu bake, but whose cadence says
  // `weekly` or `on-demand`, is a job that would double-build the HOST engine and label the
  // result with that leg's name. Checked here rather than in the shape scan because it
  // needs the leg RECORDS, which only read() can fetch.
  if (ciRecords) {
    for (const [leg, v] of Object.entries(verdicts)) {
      if (v.cadence === 'none') continue;
      examined++;
      const rec = ciRecords.get(leg);
      if (!rec) {
        findings.push(`${leg}: cadence '${v.cadence}' but the leg is not in the CI tier of `
          + 'scripts/tjs-legs.mjs — nothing can schedule it');
        continue;
      }
      const mech = nonNativeMechanism(rec);
      if (mech) {
        findings.push(`${leg}: cadence '${v.cadence}' but the leg declares '${mech}', so its `
          + 'engine is not built natively on the job host. A scheduled run would double-build '
          + "the HOST engine and label it '" + leg + "'. Set cadence 'none' with the reason, "
          + 'or teach the runner that mechanism.');
      }
    }
  }
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
  // THE WORK-COUNT FLOOR, checked BEFORE the bytes are allowed to say anything, and for
  // every recorded verdict rather than only the hopeful one. An `identical` compare over a
  // build that never ran is the vacuous verdict this gate was already caught producing
  // once (ccache served phase B entirely from phase A's cache), and its natural reading —
  // "reproducible and still reproducing" — is the most confident sentence in this file
  // attached to the least evidence. It is neither a pass nor a reproducibility failure, so
  // it gets its own outcome and that outcome FAILS: a measurement that did not happen must
  // cost someone a red, or nobody ever finds out it stopped happening.
  if (observed.insufficientWork) {
    return { ok: false, message: 'INSUFFICIENT WORK — this run produced a comparison but '
      + `not a measurement, so no verdict is returned. ${observed.insufficientWork}` };
  }
  const detail = observed.summary || (observed.identical ? 'identical' : 'DIFFERS');
  const objs = observed.differingObjects && observed.differingObjects.length
    ? `\n  differing objects:\n${observed.differingObjects.map((o) => `    ${o}`).join('\n')}`
    : '';
  // A PERTURBED RUN IS AN EXPERIMENT, judged against the claim the manifest makes for THAT
  // perturbation — never against the plain verdict. The trap: an `unproven` leg run under
  // --perturb path and coming back identical would otherwise read as "promote it to
  // reproducible", recording a fixed-path verdict from a run that never held the path fixed.
  if (observed.perturbation === 'path') {
    if (entry.pathIndependent) {
      if (observed.identical) {
        return { ok: true, message: `path-independent, as recorded, and still holding under `
          + `relocation — ${detail}` };
      }
      return { ok: false, message: 'REGRESSION — this leg records `pathIndependent` and two '
        + `builds from DIFFERENT absolute paths produced different bytes. ${detail}${objs}\n`
        + `  Recorded: ${entry.pathIndependent.where}` };
    }
    if (observed.identical) {
      return { ok: true, message: 'NOT recorded path-independent, and this run held under '
        + `relocation — ${detail}. Record it: add a \`pathIndependent\` field to this leg `
        + "with this run's sha256, bytes, date, where and config. (This does NOT settle the "
        + 'plain, fixed-path verdict, which this run never measured.)' };
    }
    return { ok: true, message: 'NOT recorded path-independent, and this run DIFFERS under '
      + `relocation — ${detail}${objs}. That is the status quo for a leg with no such `
      + 'record, not news; it becomes a finding the moment the field is added.' };
  }
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

// ---- the scheduling promise, enforced -----------------------------------------------------
//
// A GATE THAT NEVER RUNS IS NOT A GATE. This repo has already been bitten by exactly that:
// test/ccache.test.cjs's engine e2e is opt-in behind CLODE_CCACHE_ENGINE_E2E and nothing in
// .github/ sets it, so it has only ever run by hand and nothing would notice if it stopped
// working. `cadence: 'weekly'` in this file is a PROMISE, and a promise no workflow keeps is
// worse than an honest `none`. This scan is what makes the promise checkable.
//
// PURE: `workflow` is the already-read .github/workflows/repro.yml text.
function scanScheduling({ workflow, verdicts }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^\s*- cron: /m.test(workflow)) {
    findings.push('.github/workflows/repro.yml has no `- cron:` schedule — the double-build '
      + "gate would then run only when someone remembered, which is how this repo's ccache "
      + 'engine e2e went a whole phase without running');
  }

  examined++;
  if (!/node test\/repro-double-build\.cjs --leg/.test(workflow)) {
    findings.push('.github/workflows/repro.yml never invokes `node test/repro-double-build.cjs '
      + '--leg` — the workflow exists but measures nothing');
  }

  examined++;
  if (!/node test\/repro-verdicts\.cjs --matrix/.test(workflow)) {
    findings.push('.github/workflows/repro.yml does not derive its matrix from '
      + '`node test/repro-verdicts.cjs --matrix` — a leg list retyped into YAML is a second '
      + 'copy of the cadence field and rots the first time a leg is renamed');
  }

  examined++;
  if (/cancel-in-progress:\s*true/.test(workflow)) {
    findings.push('.github/workflows/repro.yml sets cancel-in-progress: true — this is a '
      + 'MEASUREMENT run, not build feedback. A cancelled run produces no verdict and, on a '
      + 'weekly cron, there is no newer run that reproduces the answer for another seven days');
  }

  examined++;
  const weekly = Object.entries(verdicts).filter(([, v]) => v.cadence === 'weekly');
  if (weekly.length === 0) {
    findings.push("no leg has cadence 'weekly', so the scheduled workflow would derive an "
      + 'empty matrix and report green having measured nothing');
  }

  return { findings, examined };
}

// THE GUARDS THEMSELVES LIVE IN test/repro-verdicts.test.cjs, NOT HERE — deliberately, and
// for two reasons. (1) test/guards-population.cjs's migration classifier defines "registers
// a guard" as a file that destructures defineGuard from guard.cjs AND calls it directly, and
// its own header records the constraint: "not a shared factory function migrated files
// merely call into". A guard defined here and merely re-exported would leave the test file
// reading as unmigrated — the ratchet would be right and the code would be wrong. (2) This
// module is also a CLI (`--matrix`), invoked by .github/workflows/repro.yml; keeping
// node:test's guard machinery out of its require graph keeps that invocation cheap and
// dependency-free. What lives here is the data and the PURE scans; what lives there is the
// defineGuard wiring that turns them into standing gates.

module.exports = {
  VERDICTS, REPRODUCIBLE, KNOWN_NOT_REPRODUCIBLE, UNPROVEN, VERDICT_RANK, GRAINS, CADENCES,
  REPRODUCIBLE_BASELINE, UNPROVEN_BASELINE,
  countByVerdict, scanManifestShape, scanCoverage, ratchetVerdicts, judgeObservation,
  matrixFor, matrixForLegs, nonNativeMechanism, ciLegRecords,
  legNamesFromManifest,
  scanScheduling, tooSlow,
};

// ---- CLI: the shape .github/workflows/repro.yml feeds to strategy.matrix.include --------
if (require.main === module) {
  const [flag, value] = process.argv.slice(2);
  if (flag === '--matrix' && CADENCES.includes(value)) {
    process.stdout.write(`${JSON.stringify(matrixFor(value))}\n`);
  } else if (flag === '--matrix-legs' && typeof value === 'string' && value.trim() !== '') {
    const names = [...new Set(value.split(',').map((n) => n.trim()).filter(Boolean))];
    process.stdout.write(`${JSON.stringify(matrixForLegs(names, '--matrix-legs'))}\n`);
  } else {
    process.stderr.write(`usage: node test/repro-verdicts.cjs --matrix <${CADENCES.join('|')}>\n`
      + '       node test/repro-verdicts.cjs --matrix-legs <leg[,leg...]>\n');
    process.exitCode = 2;
  }
}

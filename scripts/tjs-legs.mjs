#!/usr/bin/env node
// THE tjs builder leg manifest — single source of truth for BOTH GHA builds
// (user decision 2026-07-11: no duplicated leg definitions between the
// per-push and release workflows). .github/workflows/tjs-legs.yml consumes
// this via `node scripts/tjs-legs.mjs <tier>` and feeds the JSON straight to
// `strategy.matrix.include`; field names ARE the matrix keys. Invariants
// locked by test/tjs-legs.test.cjs.
//
// Tiers:
//   release — the full matrix, exactly the former release.yml inline list:
//             every arch, publish/attest flags live.
//   ci      — per-push: every OS in the matrix (user decision 2026-07-11),
//             ONE arch each. The arch twins (BSD arm64 under TCG, the
//             qemu-user musl arches) stay release-only — slow, little signal
//             beyond their amd64 siblings — as does openindiana (the illumos
//             distro twin of omnios, same kernel family). publish/attest are
//             stripped; VM legs run soft-fail (house rule: new-to-CI legs
//             EARN hard status by staying green).
//
// `ci: true` marks a leg as part of the per-push tier. Engine config
// (static/wasm/mimalloc/ffi/guest-*) is shared by construction — CI smokes
// what the release will ship (test: "byte-for-byte on engine config").

const VM = (leg) => leg['guest-platform'] && !['native', 'alpine'].includes(leg['guest-platform']);

// Version policy (user decision 2026-07-11): CI builds the NEWEST available
// version of each OS (early warning on the front edge); release builds — and
// publishes from — the OLDEST version that can still build (the compat
// floor, glibc-style). The base `os`/`guest-version` fields are the RELEASE
// values; `ci-os`/`ci-guest-version` override them for the ci tier where the
// ends differ. The release floor is EMPIRICAL, not oldest-in-catalog: old
// guest images carry old package repos (OpenBSD 6.8 ships node far below the
// build floor of 20; FreeBSD 12's pkg repos vanished at EOL) — each floor is
// walked down leg-by-leg via the tjs-legs.yml workflow_dispatch knob and
// committed only once proven green. Floors still to walk (candidates from
// the 2026-07-11 catalog sweep): netbsd 9.2, openbsd ≤7.9, freebsd ≤14.4,
// omnios r151056, openindiana 202510-build, and the arm64 twins (netbsd
// 10.0 / freebsd 12.4 / openbsd 6.8 — 300-min TCG legs, walk last). The
// alpine/musl legs are exempt: output is fully static, so the image version
// is a toolchain detail, not a compat floor. Single-version catalogs
// (dragonflybsd, midnightbsd, haiku, solaris — its variants are toolchains)
// have no ends to split. Freshness: Renovate owns the EXPLICIT ci pins (the
// `// renovate:` annotations below + customDatasources in
// .github/renovate.json — its built-in datasources can't read cpa's
// release-asset catalogs, but its custom ones can); the weekly
// scripts/check-guest-versions.mjs sweep backstops implicit pins, floor
// existence, and runner labels.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LEGS = [
  // ---- T1 native runners
  // Naming (user decision 2026-07-10): tjs builders own the CANONICAL name
  // clode-<ver>-<platform>; the transitional Node-SEA binaries carry the
  // -node engine tag instead.
  // macos-14 = the oldest arm64 runner GitHub hosts (= the publish floor);
  // ci rides the newest (macos-26).
  // publish:false: the arm64/x64 legs still build + fuse + smoke (validation) and
  // upload their bare ENGINE slice (tjs-darwin-*), which release.yml's
  // darwin-universal job lipo's into the shipped 4-arch fat binary. The single-
  // arch builders are redundant with the universal (which contains their slices)
  // — darwin ships exactly ONE artifact, clode-<ver>-macos (user pref
  // 2026-07-15). i386/ppc were never standalone (no-exec) — universal-only.
  { leg: 'darwin-arm64', os: 'macos-14', 'ci-os': 'macos-26', publish: false, pack: true, ci: true, floor: '11.0',
    // MAINTAINER RULING 2026-08-04: tier 1 keeps its STRICT meaning — all six
    // FLOOR_ROWS (A1,B1,B4,C1,D1,G7) green, no partial credit. Not one
    // run-target in the whole ledger clears that bar today, this one
    // included, so tier 0 is correct even though its coverage is the best in
    // the ledger. floorCoverage('darwin-arm64') derives this from
    // test/fidelity/RESULTS.md (do not hand-edit the tier without adding the
    // missing rows there first — test/tjs-legs.test.cjs enforces the two stay
    // consistent). Evidence behind the green rows: spike/quickjs/results/
    // cosmo-fidelity-run.md sec.3 (2026-07-29, native-tjs CONTROL, bundle
    // 2.1.218, 7/7 scenarios) + BACKLOG.md's 2026-07-30 "at parity with
    // native tjs" entry (adds Edit). tier 2 stays unclaimed regardless: F3/F4
    // remain open per this leg's long-running daily-drive notes, so even a
    // clean floor wouldn't back the full recipe.
    fidelity: { tier: 1, date: '2026-08-09', bundle: '2.1.218', how: 'primary-darwin',
                note: 'floor 6/6 GREEN (A1,B1,B4,C1,D1,G7) — the first run-target to clear the floor. A1/B1/C1/G7 from scripts/floor-probe.mjs against a freshly built quaude; D1 from a real node-pty session (TUI booted, live mock turn answered, /quit exited code 0 in 1411ms). Tier 2 stays unclaimed: F3/F4 remain open per this leg daily-drive notes' } },
  // glibc Linux: a CI-only CANARY (ciOnly:true → built in CI, filtered OUT of the
  // release tier; NB `smoke` is a different, taken field — the qemu-user smoke
  // MODE on the musl legs). The published Linux artifacts are musl-static
  // (Decision 3), so
  // glibc ships nothing today and must not gate a release. It earns its keep two
  // ways: (1) a second-libc, dynamic-link canary — a distinct compile+link
  // environment that catches non-portable code the static-musl build hides (musl's
  // tiny thread stack, getaddrinfo/NSS, symbol visibility); (2) the WARM
  // glibc-dynamic path we promote to a PUBLISHER the day we target a musl-less
  // Linux arch — musl has no port for alpha, hppa, or sparc64, so Linux on those
  // needs glibc-dynamic. The base os pins the oldest hosted ubuntu (the glibc
  // ABI floor we'd build that shipping binary against); ci rides the newest.
  { leg: 'linux-x64-glibc', os: 'ubuntu-22.04', 'ci-os': 'ubuntu-26.04', publish: false, ci: true, ciOnly: true },
  { leg: 'linux-arm64-glibc', os: 'ubuntu-22.04-arm', 'ci-os': 'ubuntu-26.04-arm', publish: false, ci: true, ciOnly: true },
  // ---- T1.5 Alpine musl-static (the published Linux artifacts)
  { leg: 'linux-x64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'x86_64',
    static: true, publish: true, ci: true,   // ci: per-push twin of THE published Linux artifact
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run on the ubuntu runner (static musl, same kernel+arch)); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'linux-arm64-musl', os: 'ubuntu-24.04-arm', 'guest-platform': 'alpine', 'guest-arch': 'aarch64',
    static: true, publish: true,              // alpine container on the arm runner
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run on the ubuntu-24.04-arm runner (static musl)); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'linux-s390x-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 's390x',
    static: true, wasm: 'off',                // WAMR's MAP_32BIT is x86/ARM-only; undefined on s390x
    publish: true, smoke: 'version',          // PONG-class smoke lives in the be-oracle job
    timeout: 300, 'soft-fail': true,          // slow qemu-user BE leg — non-blocking (plan T1.5)
    fidelity: { tier: 0,
                note: 'zero floor coverage: this leg smokes --version only (smoke: \'version\'), so the build-pipeline PONG turn NEVER runs on s390x — see RESULTS.md "What earns a row"' } },
  // ---- Phase-2 legs (plan Q2 PHASE-2 PICKUP). New legs start soft-fail and
  // EARN hard status by smoking green (house rule) — dispatches #5-#13
  // hardened everything except the slow qemu-user TCG class (non-blocking by
  // design, like s390x). publish:true only materializes an artifact when the
  // leg is green.
  // darwin-x64 floor walk (spec 2026-07-11): release builds against the
  // pinned 10.6 SDK with deployment target 10.6 — the oldest macOS with a
  // real x86_64 userland, so one honest floor covers every 64-bit Intel Mac
  // (and becomes the x86_64 SLICE of the universal fat binary later). ci
  // would ride the stock runner SDK (fields stripped) if this leg joins ci.
  // wasm/mimalloc off: the ONLY thread-local storage in the whole stack
  // lives in WAMR + mimalloc, and Darwin TLV needs a 10.7+ target — same
  // config every VM leg ships. ffi off: nothing shipped imports tjs:ffi,
  // and it spares the 10.6 sysroot a libffi question (also VM-leg parity).
  // PROVEN floor (probe run 29166443318, 2026-07-11): honest 10.6-SDK
  // build (Csu-grafted crt1.10.6.o), fuse + full quaude smoke green on
  // macos-15-intel, floor gate LC_VERSION_MIN_MACOSX 10.6. Walk receipts:
  // probe 1 = 29165326041 (crt wall), probe 2 = 29165510612 (CXX wall),
  // then the local Rosetta bench (PINS.md "darwin floor walk fixups").
  // REAL-HARDWARE PROOF 2026-07-11: on Mavericks 10.9.5 (Darwin 13.4.0,
  // x86_64) the builder ran, fetched the provider (mbedtls TLS), fused a
  // quaude ON the box (29MB, bundle 2.1.179), PONG + attest green, quaude
  // answers --version. The 10.6..10.9 gap is covered by the honest SDK.
  { leg: 'darwin-x64', os: 'ubuntu-latest', publish: false, pack: true,  // slice-only builder (ships via darwin-universal); engine IS a cross-build --target
    // CROSS-BUILT on ubuntu via the osxcross image (ci/osxcross-darwin, built in
    // CI with GHA layer cache) — off the deprecating macos-15-intel runner
    // (proven end-to-end on real Mavericks). no-exec: a Mach-O can't run on the
    // Linux builder (the universal job can smoke the x64 slice under Rosetta on
    // macos-26). macos-min/arch feed the floor gate; the cross toolchain file
    // (scripts/darwin-x64.toolchain.cmake) carries the actual 10.6 floor.
    'cross-dockerfile': 'ci/osxcross-darwin', 'cross-file': 'scripts/darwin-x64.toolchain.cmake',
    'macos-min': '10.6', 'macos-arch': 'x86_64', floor: '10.6', 'no-exec': true,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    // Commit 57fb352 (2026-07-11, "darwin-x64 floor proven on real Mavericks
    // hardware"): on a real Mavericks 10.9.5 box (Darwin 13.4.0, x86_64) the
    // builder fetched the provider over mbedtls TLS and fused a 29MB quaude
    // ON-BOX (bundle 2.1.179), PONG + attest green, quaude answers --version.
    // `PONG` in libexec/clode-fuse.cjs is exactly RECIPE G7 (`-p 'say PONG'`
    // against a mock, exit 0 + response matched + POST verified) — real, not
    // asserted, evidence. That equivalence is now WRITTEN DOWN and applied to
    // every leg that executes the smoke on its own target (RESULTS.md, "What
    // earns a row" #2): it was being counted here and silently discounted on
    // ~19 other legs running the identical smoke. This leg is `no-exec` in CI,
    // so its G7 comes from the on-box Mavericks run, not from a leg job.
    // MAINTAINER RULING 2026-08-04: tier 1 requires all
    // six FLOOR_ROWS green (no partial credit); only G7 is covered here (no
    // A1/B1/B4/C1/D1 evidence for this run-target — the leg is no-exec off
    // the darwin-universal path, so the Mavericks box, not the ubuntu
    // cross-builder, is what ran). tier 0 is correct; the G7 evidence is real
    // and recorded, not discarded. floorCoverage('darwin-x64') derives this
    // from test/fidelity/RESULTS.md.
    fidelity: { tier: 0, date: '2026-07-11', bundle: '2.1.179', how: 'mavericks-vm',
                note: 'floor 1/6 green (G7); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  // darwin-x86 Tiger walk (spec 2026-07-11-darwin-x86-tiger-walk): the
  // i386 slice at floor 10.4 — second slice of the 4-way fat binary.
  // ENGINE-ONLY (no-exec): no GitHub runner can execute i386 (mac
  // runners are >=10.15, Rosetta 2 is x86_64-only), so the leg builds and
  // floor-gates the bare tjs and publishes nothing; the fuse chain is
  // proven on the Mavericks box (10.9 runs i386 natively), and a
  // publishable i386 BUILDER waits on cross-fuse prerequisite 3 (this
  // leg is its motivating consumer). Same engine knobs as darwin-x64
  // (Darwin TLV needs 10.7+; Tiger ALSO has no posix_spawn — the
  // spawn-model axis fixups ride build-tjs.mjs).
  // PROVEN floor (probe run 29168027051, 2026-07-11): honest 10.4u-SDK
  // build (the repack ships its own fat crt1.o — no Csu graft), engine
  // floor gate LC_VERSION_MIN_MACOSX 10.4 + i386 arch marker green on
  // macos-15-intel. Walk = 6 Rosetta-bench rounds (build-only), headline
  // fix = the spawn-model axis (UV__HAVE_POSIX_SPAWN + sync-spawn v3
  // fork/exec sibling — pre-10.5 has no posix_spawn at all). REAL-
  // HARDWARE PROOF 2026-07-11 on Mavericks 10.9.5 (runs i386 natively):
  // shim smoke ok, async spawn via libuv's fork/exec route ok, sync
  // spawn via the v3 fork/exec sibling ok — both new spawn paths ran
  // real children on real hardware. STRETCH PROVEN same day: an i386
  // BUILDER was fused ON the box (CLODE_TJS=<this engine> + the x64
  // builder + CLODE_MAIN_BUNDLE, 11.3MB, self-smoke green) — the first
  // cross-arch fuse in the wild, cross-fuse prereq 3's proof-of-need.
  // (True-Tiger execution awaits Tiger hardware or the qemu-ppc-era
  // oracle legs; 10.4..10.9 gap covered by the honest SDK.)
  // CROSS-BUILT on ubuntu via the osxcross image (i386-apple-darwin8, LEGACY
  // osxcross-1.1 + 10.4u SDK — see ci/osxcross-darwin/Dockerfile) — off the
  // macos-15-intel runner, proven on real Mavericks (10.9 runs i386). HARD (not
  // soft-fail): four arches or not release-ready — a missing i386 slice must
  // block the release, not ship a 3-arch fat. Deterministic cross-build, no flake.
  { leg: 'darwin-x86', os: 'ubuntu-latest', publish: false, pack: true,
    'cross-dockerfile': 'ci/osxcross-darwin', 'cross-file': 'scripts/darwin-x86.toolchain.cmake',
    'macos-min': '10.4', 'macos-arch': 'i386', floor: '10.4', 'no-exec': true,
    // Darwin 8 kqueue drops events under load (proven on ppc; ASSUMED here — no
    // Tiger/i386 box exists, and this leg is no-exec). Costs uv_fs_event (ENOSYS);
    // revisit per the BACKLOG item once an i386 target is reachable.
    'darwin-poll': true,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    // No-exec cross-build: engine-only proof (real Mavericks i386 spawn/shim
    // smoke, memory darwin-x86-tiger-walk), never driven as a standalone
    // run-target — the box that proved it ran x64/i386, not the ubuntu builder.
    fidelity: { tier: 0 } },
  // darwin-ppc Tiger walk (spec 2026-07-11-darwin-ppc-walk): the ppc/BE32
  // slice at floor 10.4 — third slice of the fat binary, first BE slice.
  // CROSS-BUILT on ubuntu inside the digest-pinned VariantXYZ image (gcc
  // 14.2 powerpc-apple-darwin8 + cctools-port ppc ld + baked 10.4u SDK) —
  // the first darwin leg that is neither a mac runner nor a guest VM. No
  // native SDK fetch (baked); no fuse/publish (no-exec: nothing in GHA
  // execs ppc). ENGINE PROVEN on real Tiger PowerPC (run 29182716872):
  // boots the LE bundles via canonical-LE, regexps/spawn/numerics correct.
  // Walls cleared: __atomic_*_8 link (CLODE_TJS_ATOMIC_SHIM) + canonical-LE
  // v5 regexp-endian discriminator. Publishable ppc BUILDER awaits
  // cross-fuse (this leg + darwin-x86 are its consumers).
  { leg: 'darwin-ppc', os: 'ubuntu-latest', publish: false, pack: true,
    'macos-min': '10.4', 'macos-arch': 'ppc', floor: '10.4',
    // renovate: datasource=docker depName=ghcr.io/variantxyz/gcc-powerpc-apple-darwin8
    'cross-image': 'ghcr.io/variantxyz/gcc-powerpc-apple-darwin8@sha256:a9013745ae4a696dc3a047675a85e7c43b9453cdb1e26d9a7ac9738587c1e198',
    // cross-file defaults to scripts/darwin-ppc.toolchain.cmake; the image
    // bakes its toolchain so cross-apt stays empty. atomic-shim: the 32-bit-BE
    // __atomic_*_8 link wall (formerly hardcoded in the exec=cross step, now a
    // per-leg field so the tier-2 Debian cross legs can turn it off).
    'atomic-shim': true,
    // Tiger's kqueue drops socket/pipe/SIGCHLD/async delivery under the fused
    // runtime's fd load (ktrace-confirmed, memory tiger-ppc-agentic-turn-deadlock):
    // build libuv's generic poll(2) backend instead of kqueue.c.
    'darwin-poll': true,
    // HARD (not soft-fail): four arches or not release-ready (see darwin-x86).
    // Cross-build via a digest-pinned image — deterministic, no flake to tolerate.
    'no-exec': true, wasm: 'off', mimalloc: 'off', ffi: 'off',
    // Driven on real Tiger PPC hardware (RESULTS.md: B1, C1, G7 pass); G6
    // (credentialed startup stall) is RECIPE-OPEN, not swept under the rug.
    // MAINTAINER RULING 2026-08-04: tier 1 requires all six FLOOR_ROWS green
    // (no partial credit); A1/B4/D1 have no rows here, so tier 0 is correct
    // even though this is real hardware evidence, not an unmeasured guess.
    // floorCoverage('darwin-ppc') derives this from test/fidelity/RESULTS.md.
    fidelity: { tier: 0, date: '2026-07-31', bundle: '2.1.218', how: 'tiger-ppc-vm',
                note: 'floor 3/6 green (B1,C1,G7); A1,B4,D1 not driven; RECIPE G6 credentialed startup stall also OPEN — see RESULTS.md' } },
  // windows-amd64 (native engine leg): compiles tjs.exe ON windows-latest with
  // MSVC cl.exe (CLODE_TJS_WIN_MSVC — the Activate-MSVC-dev-env step +
  // ilammy/msvc-dev-cmd), so build-leg's exec=host machinery does build +
  // fuse + PONG in ONE windows job (like darwin) and PUBLISHES
  // clode-<ver>-windows-amd64 the normal exec=host way. The canonical Windows
  // leg — a hard gate (a broken publisher must fail red). Same
  // wasm/mimalloc/ffi-off config as the other floor legs. The finer shim +
  // sync-primitive signals run in ci.yml's windows-amd64-tests job against this
  // leg's tjs-windows-amd64 artifact. (Phase B: cl.exe proven on the transient
  // windows-amd64-msvc leg, then flipped in as the canonical compiler and that
  // leg deleted — mingw is retired.)
  { leg: 'windows-amd64', os: 'windows-latest', msvc: true, publish: true, ci: true,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 4/6 green (A1,B1,C1,G7); B4,D1 missing — see RESULTS.md. A1/B1/C1 driven 2026-08-09 on REAL Windows (cmbx-windows) by scripts/floor-probe.mjs over ssh, against a quaude cross-fused here from the cached PE32+ engine; B4 needs all four tools and D1 needs a pty on the target' } },
  // windows-arm64 (the Windows finale): native MSVC ARM64 on the windows-11-arm
  // runner (msvc-arch:arm64 → the dev-env's cl targets ARM64), exec=host build +
  // fuse + PONG like windows-amd64. PUBLISHES clode-<ver>-windows-arm64 — the asset
  // the release.yml tripwire requires (Phase 4 dropped the SEA arm64 leg). Proven
  // green first try (cl.exe de-risked the build), now a HARD publisher like
  // windows-amd64. Finer signals run in ci.yml's windows-arm64-tests job.
  { leg: 'windows-arm64', os: 'windows-11-arm', msvc: true, 'msvc-arch': 'arm64',
    publish: true, ci: true, wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run natively on the windows-11-arm runner); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  // ---- T1.5 extra musl arches. x86 execs natively on the x64 kernel (full
  // smoke); the rest are qemu-user with version-smoke like s390x. wasm off:
  // MAP_32BIT is x86_64/aarch64-only in musl headers — and 32-bit WAMR is
  // worthless to us anyway.
  { leg: 'linux-x86-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'x86',
    static: true, wasm: 'off', publish: true,  // 32-bit LE
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run natively by the x86_64 runner kernel (static musl)); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'linux-armv7-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'armv7',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true,  // qemu-user (Cobalt runners lack aarch32 EL0)
    fidelity: { tier: 0,
                note: 'zero floor coverage: this leg smokes --version only (smoke: \'version\'), so the build-pipeline PONG turn NEVER runs on armv7 — see RESULTS.md "What earns a row"' } },
  { leg: 'linux-ppc64le-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'ppc64le',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true,  // qemu-user
    fidelity: { tier: 0,
                note: 'zero floor coverage: this leg smokes --version only (smoke: \'version\'), so the build-pipeline PONG turn NEVER runs on ppc64le — see RESULTS.md "What earns a row"' } },
  { leg: 'linux-riscv64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'riscv64',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true,  // qemu-user
    fidelity: { tier: 0,
                note: 'zero floor coverage: this leg smokes --version only (smoke: \'version\'), so the build-pipeline PONG turn NEVER runs on riscv64 — see RESULTS.md "What earns a row"' } },
  { leg: 'linux-loongarch64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'loongarch64',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true,  // qemu-user (alpine >= 3.21)
    fidelity: { tier: 0,
                note: 'zero floor coverage: this leg smokes --version only (smoke: \'version\'), so the build-pipeline PONG turn NEVER runs on loongarch64 — see RESULTS.md "What earns a row"' } },
  // ---- T2 VM legs: fuse + smoke run INSIDE the guest (exec=guest —
  // BSD/illumos binaries have no binfmt escape on a Linux host). Config:
  // wasm off (WAMR "linux"-platform mremap wall on every non-Linux POSIX),
  // mimalloc off (NetBSD compile regression; start uniform, re-enable
  // per-platform as legs prove), ffi off (spares a guest libffi dep; nothing
  // shipped imports tjs:ffi). Engine config (quickjs + wurl + libuv)
  // identical to the pinned oracle build.
  { leg: 'netbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'netbsd',
    // Floor at 10.1 to match every other NetBSD arch (user decision 2026-07-15:
    // "10.x for everything"). NetBSD 9.x goes unsupported once 11.0 leaves RC, so
    // there's no reason to keep the old 9.4 floor (9.4/10.0 both built cleanly —
    // probes 29160710037/29160710641 — but 9.x's audience is evaporating).
    // COMPAT carries a 10.1 build forward across 10.x. (Reach note: 10.0 users
    // would need a 10.0 floor; dropped as marginal vs. a tidy uniform 10.1.)
    'guest-version': '10.1',
    // renovate: datasource=custom.cpa-netbsd-x86-64 depName=netbsd-x86-64-guest versioning=loose
    'ci-guest-version': '10.1',
    'guest-packages': 'cmake gmake nodejs git-base bash', floor: '10.1',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,  // cpa, KVM
    // DEMOTED to tier 0 (2026-08-04 audit): the amd64 rung was explicitly
    // ABANDONED for local fidelity work on 2026-07-06 in favor of aarch64
    // (spike/quickjs/results/gate3-netbsd-aarch64.md: "This target replaced
    // the planned NetBSD/amd64 rung ... the abandoned amd64/TCG rung needed
    // ~25 minutes just to install and never got through pkg_add"). No hand
    // drive, no spike scorecard exists for netbsd-amd64.
    // What it DOES have (2026-08-04, "what earns a row" ruling): G7, from the
    // build-pipeline PONG smoke that fuses and runs a quaude inside the NetBSD
    // 10.1/amd64 guest on every build. That earlier "no evidence beyond
    // ordinary green CI build+smoke" note was the inconsistency the ruling
    // fixed — the identical smoke was being counted for darwin-x64 and
    // discounted here. It is one row, not a tier: A1/B1/B4/C1/D1 remain undriven.
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); '
                      + 'A1,B1,B4,C1,D1 not driven; the hand-driven amd64 rung was abandoned '
                      + '2026-07-06 in favor of arm64 — see RESULTS.md' } },
  { leg: 'freebsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'freebsd',
    // PROVEN floor (probe run 29157832721, honest in-guest build): 14.0 is
    // the oldest whose pkg repos still exist — 12.x/13.x died with their
    // branches at EOL (probes failed before any build). FreeBSD symbol
    // versioning gives 14.0-built binaries forward-compat across 14.x/15.x.
    'guest-version': '14.0',
    // renovate: datasource=custom.cpa-freebsd-x86-64 depName=freebsd-x86-64-guest versioning=loose
    'ci-guest-version': '15.1',
    'guest-packages': 'cmake gmake node git bash', floor: '14.0',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,  // cpa, KVM
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  // OpenBSD is EXEMPT from publish-oldest: ld.so refuses on libc.so major
  // mismatch and majors bump nearly every release, in BOTH directions
  // (probe evidence: the 7.9-built tjs died on 7.6 with "can't load library
  // libc.so") — so an old-built artifact serves only that one old release
  // and breaks everyone current. Publish the newest instead; 7.6 is proven
  // to BUILD (probe run 29157832086, honest build) but a 7.6 artifact would
  // be useless to 7.9 users.
  { leg: 'openbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-version': '7.9',
    'guest-packages': 'cmake gmake node git bash', floor: '7.9',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,  // cpa, KVM
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'dragonflybsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'dragonflybsd', 'guest-version': '6.4.2',
    'guest-packages': 'cmake gmake node git bash', floor: '6.4.2',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,  // cpa, KVM
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'omnios-amd64', os: 'ubuntu-latest', 'guest-platform': 'omnios',
    'guest-version': 'r151056',        // PROVEN floor (probe run 29154489454, 2026-07-11) — oldest in cpa catalog
    // renovate: datasource=custom.cpa-omnios-x86-64 depName=omnios-x86-64-guest versioning=loose
    'ci-guest-version': 'r151058',
    'guest-packages': 'developer/gcc14 developer/build/gnu-make ooce/developer/cmake ooce/runtime/node-22 developer/versioning/git shell/bash',
    floor: 'r151056',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,  // cpa, KVM (illumos rung)
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'solaris-amd64', os: 'ubuntu-latest', 'guest-platform': 'solaris',
    'guest-version': '11.4-gcc',       // CBE image with gcc/g++ preinstalled
    // renovate: datasource=custom.vmactions-solaris depName=solaris-guest versioning=loose
    'ci-guest-version': '11.4-gcc-14', // same OS, newer image+toolchain (variants: renovate.json allowedVersions pins /gcc/)
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git runtime/nodejs shell/bash',
    floor: '11.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,
    timeout: 120,                 // vmactions boot is slower than cpa
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  // ---- Sweep 2 (2026-07-10): the remaining easy adds on proven machinery.
  // BSD arm64 = cpa's other architecture (TCG on GitHub runners — no
  // /dev/kvm — hence the long timeouts); MidnightBSD + Haiku = cpa's
  // remaining x86-64 catalog; OpenIndiana = the third illumos flavor via
  // vmactions (the __sun fixups transfer). All soft-fail until they earn
  // hard status.
  { leg: 'netbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'netbsd', 'guest-arch': 'arm64',
    'guest-version': '10.1', 'guest-packages': 'cmake gmake nodejs git-base bash', floor: '10.1',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true,  // cpa, TCG
    // CORRECTED 2026-08-04 audit: date/bundle were wrong (2.1.218 did not exist
    // on 2026-07-25 as originally claimed — first appears 2026-07-23, 4db0a21).
    // Real dated evidence is the phase-3 NetBSD/evbarm-aarch64 qemu+HVF spike,
    // 2026-07-09, bundle 2.1.204 exactly (commit b625bdb/1b6881c;
    // spike/quickjs/results/phase3-netbsd-aarch64-scorecard.md): mock PONG -p
    // round-trip PASS + agentic Bash tool round-trip PASS (tool_result stdout
    // inline, is_error false, after a real portability wall — Bash tool shell
    // discovery needs bash/zsh by name, fixed with pkgsrc bash). 'how' points at
    // its own PLATFORMS.md rig (netbsd-aarch64-spike-vm, added 2026-08-04) rather
    // than borrowing the persistent SSH-VM rig's id — this run predates that
    // runbook and used a different, ephemeral qemu+HVF guest.
    // MAINTAINER RULING 2026-08-04: tier 1 requires all six FLOOR_ROWS green
    // (no partial credit); A1/B4/C1/D1 have no rows here, so tier 0 is
    // correct. floorCoverage('netbsd-arm64') derives this from
    // test/fidelity/RESULTS.md rows G7, B1.
    fidelity: { tier: 0, date: '2026-07-09', bundle: '2.1.204', how: 'netbsd-aarch64-spike-vm',
                note: 'floor 2/6 green (B1,G7); A1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'freebsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'freebsd', 'guest-arch': 'arm64',
    'guest-version': '14.4', 'guest-packages': 'cmake gmake node git bash', floor: '14.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true,  // cpa, TCG
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest under TCG); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'openbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-arch': 'arm64',
    'guest-version': '7.9', 'guest-packages': 'cmake gmake node git bash', floor: '7.9',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true,  // cpa, TCG
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest under TCG); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'midnightbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'midnightbsd', 'guest-version': '4.0.4',
    // no git: the 4.0.4 mport tree's git dep chain is broken (p5-Digest-HMAC
    // wants perl >= 5.40.3, image ships 5.38.5 — dispatch #14); every cmake
    // git usage is if(GIT_EXECUTABLE)-guarded, so the build does not need it.
    'guest-packages': 'cmake gmake node bash', floor: '4.0.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true,  // cpa, KVM (mport packages)
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'haiku-x64', os: 'ubuntu-latest', 'guest-platform': 'haiku', 'guest-version': 'r1beta5',
    // HaikuPorts ships exactly ONE node: nodejs20 (user-verified, 2026-07-10)
    // — named explicitly; v20 clears the build floor (lowered to 20 for
    // OpenIndiana the same day). cmd:X provides-syntax for the rest
    // ("nodejs" alone: Name not found, #14).
    'guest-packages': 'cmd:cmake cmd:gcc nodejs20 cmd:git cmd:make', floor: 'r1beta5',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true,  // cpa, KVM (a genuinely new OS rung)
    // PLATFORMS.md documents a Haiku RIG (how to reach the box, which rows to
    // run) -- a runbook, not a result. Nobody has ever hand-driven the recipe
    // on Haiku; the other Haiku evidence on record is a >64KB uv_write deadlock
    // isolated by bare-engine probes (memory: haiku-tjs-write-deadlock) --
    // engine debugging, not a floor drive. As of the 2026-08-04 "what earns a
    // row" ruling it does hold G7: the build-pipeline PONG smoke fuses and runs
    // a quaude inside the Haiku guest on every build (so a -p turn is not
    // blocked by the uv_write class). C2, the row that deadlock actually
    // threatens, is NOT a floor row and remains undriven here.
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); '
                      + 'A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  { leg: 'openindiana-amd64', os: 'ubuntu-latest', 'guest-platform': 'openindiana',
    // PROVEN floor (probe run 29154489921, 2026-07-11) — oldest vmactions
    // conf; build-essential image. Release-only leg (illumos distro twin):
    // no ci newest-end, so no split and no Renovate pin — the weekly watcher
    // guards this floor's existence.
    'guest-version': '202510-build',
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git shell/bash runtime/nodejs',
    floor: '202510',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 120, 'soft-fail': true,  // vmactions (3rd illumos flavor)
    fidelity: { tier: 0, date: '2026-08-02', how: 'ci',
                note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run in-guest); A1,B1,B4,C1,D1 not driven — see RESULTS.md' } },
  // netbsd-sparc (the first truly-weird platform; cross-fuse A+B1+C): the sparc
  // tjs ENGINE is built once via the source-hash tjs-cache (TCG bake on miss);
  // per-run cross-fuses the clode --self builder on the x64 runner (Layer A,
  // CLODE_TARGET_TEMPLATE=sparc engine), then boots the pristine sparc image and
  // runs clode-on-sparc to FUSE a quaude + PONG (Layer C). Publishes
  // clode-<ver>-netbsd10.1-sparc. soft-fail (TCG flake non-blocking); the release
  // required-assets tripwire gates on the sparc asset. First user of the own-qemu
  // guest backend.
  { leg: 'netbsd-sparc', os: 'ubuntu-latest', 'guest-platform': 'qemu-netbsd-sparc', 'guest-arch': 'sparc',
    floor: '10.1', 'guest-version': '10.1', publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    // CORRECTED 2026-08-04 audit: bundle was wrong (2.1.218 did not exist on
    // 2026-07-09 as originally claimed — first appears 2026-07-23, 4db0a21;
    // also the original note claimed "canonical-LE bytecode proof", but
    // canonical-LE didn't land until 2026-07-11/12, AFTER this run — this
    // evidence predates it and used a different bytecode-checksum workaround
    // (host-esbuild + in-guest native tjsc regen). Real dated evidence: commit
    // 75bbf1c "S2/S4/S5 ALL GREEN" — bundle 2.1.204 exactly, mock PONG -p
    // round-trip (real POST /v1/messages + literal PONG on the sun4m guest
    // console, 66s e2e under TCG). See test/fidelity/RESULTS.md row G7.
    // MAINTAINER RULING 2026-08-04: tier 1 requires all six FLOOR_ROWS green
    // (no partial credit); A1/B1/B4/C1/D1 have no rows here, so tier 0 is
    // correct. floorCoverage('netbsd-sparc') derives this from RESULTS.md.
    fidelity: { tier: 0, date: '2026-07-09', bundle: '2.1.204', how: 'sparc-vm',
                note: 'floor 1/6 green (G7); A1,B1,B4,C1,D1 not driven; predates canonical-LE — see RESULTS.md' } },
  // ---- cross-toolchain tier-2 (2026-07-14): cross-compiled on the x64 runner
  // inside a stock Debian image (cross-apt names the gcc-<triple>), then the
  // shared cross-fuse (tier2:true) emits a clode BUILDER against the foreign
  // engine — no runner can exec the target, so no-exec:true and the tier2 block
  // owns the upload. atomic-shim off: s390x/riscv64 have native 64-bit atomics.
  // Engine knobs match the VM legs (wasm/mimalloc/ffi off). soft-fail until they
  // earn hard status (house rule). Not in the ci tier — release-only, like the
  // arch twins. cross-image is a rolling Debian tag (Renovate-tracked).
  //
  // linux-riscv64 (64-bit LE): the easy LE cross proof — no canonical-LE
  // special-casing needed. verify=qemu-user (level-2 self-load required,
  // level-2.5 full fuse attempted+logged).
  { leg: 'linux-riscv64', os: 'ubuntu-latest', 'guest-arch': 'riscv64',
    // renovate: datasource=docker depName=debian
    'cross-image': 'debian:trixie',
    'cross-file': 'scripts/linux-riscv64.toolchain.cmake',
    'cross-apt': 'cmake make gcc-riscv64-linux-gnu g++-riscv64-linux-gnu',
    'atomic-shim': false, tier2: true, verify: 'qemu-user', 'no-exec': true,
    // publish:false — glibc-dynamic with no ABI floor (Decision 3: glibc Linux
    // artifacts are smoke-only; the PUBLISHED riscv64/s390x Linux artifacts are
    // the musl-static twins). This leg stays as canonical-LE + qemu-user proof.
    publish: false, 'soft-fail': true, timeout: 1800,
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
  // linux-s390x (64-bit BIG-endian): the canonical-LE-on-64-bit-BE witness.
  // Its qemu-user level-2 self-load proves the canonical-LE reader deserializes
  // the shipped LE core bytecode on a 64-bit BE arch (sparc proved 32-bit BE) —
  // the runtime half of the canonical-LE story. Same Debian-cross tier-2 shape
  // as riscv64; atomic-shim off (s390x has native 64-bit atomics).
  { leg: 'linux-s390x', os: 'ubuntu-latest', 'guest-arch': 's390x',
    // renovate: datasource=docker depName=debian
    'cross-image': 'debian:trixie',
    'cross-file': 'scripts/linux-s390x.toolchain.cmake',
    'cross-apt': 'cmake make gcc-s390x-linux-gnu g++-s390x-linux-gnu',
    'atomic-shim': false, tier2: true, verify: 'qemu-user', 'no-exec': true,
    // publish:false — glibc-dynamic with no ABI floor (Decision 3: glibc Linux
    // artifacts are smoke-only; the PUBLISHED riscv64/s390x Linux artifacts are
    // the musl-static twins). This leg stays as canonical-LE + qemu-user proof.
    publish: false, 'soft-fail': true, timeout: 1800,
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
  // netbsd-m68k (TIER-2, built-not-run): 32-bit BIG-endian NetBSD userland,
  // cross-built via a NetBSD `build.sh -m <port> tools`+`distribution`
  // toolchain (the showcase — any NetBSD arch is one command; no per-arch
  // cross-gcc packaging). No cross-image; netbsd-src routes build-leg through
  // ./.github/actions/netbsd-crossbuild. m68k has no MACHINE of its own, so a
  // port carries the shared m68k--netbsdelf toolchain (atari — classic, stable,
  // in every branch; the userland ELF is arch-based, runs on any m68k NetBSD).
  // verify=none: NetBSD has no qemu-user, so it is built-not-run (the file is an
  // m68k NetBSD ELF; qemu-system-m68k virt full-smoke is the level-3 upgrade,
  // out of scope). atomic-shim on (m68k lacks 8-byte libatomic, like sparc/ppc).
  { leg: 'netbsd-m68k', os: 'ubuntu-latest', 'guest-arch': 'm68k',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'atari',
    'cross-file': 'scripts/netbsd-m68k.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // ---- NetBSD arch fleet (v0.1.4). The build.sh cross path proven generic:
  // scripts/netbsd.toolchain.cmake DISCOVERS the cross triple from the build.sh
  // tooldir, so a fleet arch is just {netbsd-machine (a port), guest-arch,
  // atomic-shim}. All tier-2 built-not-run (verify=none, no qemu-user for
  // NetBSD); the arch gate (file(1)) is the proof. atomic-shim only on 32-bit
  // arches lacking 8-byte libatomic.
  //
  // netbsd-sparc64 (64-bit BE): distinct from the 32-bit netbsd-sparc (own-qemu).
  // Proven locally 2026-07-14 (docker-loop netbsd-fleet.sh): sparc64--netbsd
  // toolchain, ELF 64-bit MSB SPARC V9 NetBSD, no shim (64-bit inlines atomics).
  { leg: 'netbsd-sparc64', os: 'ubuntu-latest', 'guest-arch': 'sparc64',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'sparc64',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': false, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    // publish:false + soft-fail: fleet legs ONBOARD as proving legs (built +
    // arch-gated in CI, non-blocking) and flip to publish:true only once CI-green
    // — a new build.sh arch must not gate a release before it is proven.
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // ---- Fleet batch 2 (2026-07-15): the next 5 build.sh cross arches, all
  // ONBOARDING (publish:false + soft-fail — built + arch-gated in CI, non-blocking,
  // no-exec since NetBSD has no qemu-user). Each is just {netbsd-machine (a port),
  // guest-arch (drives the file(1) arch gate), atomic-shim}. atomic-shim on the
  // 32-bit arches lacking 8-byte libatomic (all but alpha). Proven-locally status
  // varies (alpha proven; hppa/macppc/pmax/sgimips grinding) — CI is the wall-walk.
  // netbsd-alpha (64-bit LE): 64-bit ll/sc inlines 8-byte atomics, no shim.
  { leg: 'netbsd-alpha', os: 'ubuntu-latest', 'guest-arch': 'alpha',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'alpha',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': false, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-hppa (32-bit BE PA-RISC): weak atomics (ldcw only) — shim on.
  { leg: 'netbsd-hppa', os: 'ubuntu-latest', 'guest-arch': 'hppa',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'hppa',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-macppc (32-bit BE PowerPC): 32-bit lwarx/stwcx — 8-byte needs shim.
  { leg: 'netbsd-macppc', os: 'ubuntu-latest', 'guest-arch': 'powerpc',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'macppc',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-pmax (32-bit LE MIPS, DECstation): MIPS32 ll/sc is 32-bit — shim on.
  { leg: 'netbsd-pmax', os: 'ubuntu-latest', 'guest-arch': 'mipsel',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'pmax',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-sgimips (32-bit BE MIPS, SGI): the mipseb twin of pmax — shim on.
  { leg: 'netbsd-sgimips', os: 'ubuntu-latest', 'guest-arch': 'mipseb',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'sgimips',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // ---- Fleet batch 3 (v0.1.4): 5 more build.sh cross arches, extending the fleet
  // toward the ~20-24 buildable of NetBSD's 43 MACHINE_ARCH. Pattern:
  // {netbsd-machine (a PORT), guest-arch (drives the file(1) gate), atomic-shim}.
  // Single-arch ports (i386) take build.sh -m alone; MULTI-arch ports (evbarm,
  // sbmips, evbsh3) have no default and abort "No MACHINE_ARCH provided" without an
  // explicit netbsd-arch (build.sh -a), added to the crossbuild composite in this batch.
  // Onboarded as no-exec probes (soft-fail, non-blocking — NetBSD has no qemu-user).
  // Those that earned a green cross-build were promoted to publish:true and SHIPPED in
  // 0.20260718.1 (earmv7hf, and batch-2 sgimips/sh3el/etc). Those that have NEVER built
  // (i386, riscv64, mips64eb) are held ciOnly:true — built in CI to see if they compile,
  // but filtered OUT of the release matrix (legsFor('release')): a never-built arch must
  // not ride — let alone gate — a release. Drop ciOnly + set publish:true once green.
  // atomic-shim on the 32-bit arches lacking inlined 8-byte atomics
  // (i386 has cmpxchg8b, ARMv7 has ldrexd → no shim; vax/sh3 → shim). canonical-LE
  // carries the shipped LE bytecode onto the BE target (mips64eb — new 64-bit-BE
  // engine coverage beyond s390x/sparc64). Confidence varies (i386 high; the
  // port-default arch for evbarm/riscv/sbmips/evbsh3 is CI-adjudicated; vax is a
  // KNOWN hard-arch — see BACKLOG "NetBSD hard-arch tier" — onboarded as a wall).
  //
  // netbsd-i386 (x86-32 LE): the 32-bit x86 port. atomic-shim ON — the netbsd-10
  // i386 toolchain targets the i486 baseline (i486--netbsdelf-gcc), which has NO
  // cmpxchg8b (that is i586/Pentium), so gcc emits __atomic_*_8 LIBCALLS for the
  // 8-byte atomics quickjs's Atomics builtin needs, and there is no libatomic in
  // the sysroot → link fails on __atomic_compare_exchange_8 et al (run
  // 30071235373). Same wall as m68k/ppc/sparc; our pthread-mutex shim resolves it.
  // (The earlier "cmpxchg8b → no shim" note was wrong: i486 predates cmpxchg8b.)
  { leg: 'netbsd-i386', os: 'ubuntu-latest', 'guest-arch': 'i386',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'i386',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    // REVIVED 2026-07-24 (ci:true, soft-fail): the wall was diagnosed and fixed.
    // quickjs compiled fail on 32-bit x86 — JS_X87_FPCW_SAVE_AND_ADJUST expands
    // to a declaration right after the `handle_float64:` label (illegal pre-C23);
    // build-tjs's fixupQjsX87FpcwLabelStmt inserts a null statement there. Both
    // fixes proven green (run 30079326329). SHIPPED 2026-07-24: a deterministic
    // cross-build earns a hard release gate like earmv7hf/riscv64. Ships as
    // clode-<ver>-netbsd10.1-i386. soft-fail stripped from publishers on the
    // release tier; stays soft on the CI on-ramp. no-exec: green = it built.
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-earmv7hf (ARM32 LE hardfloat): evbarm's default arch; ARMv7 ldrexd
  // inlines 8-byte atomics → no shim.
  { leg: 'netbsd-earmv7hf', os: 'ubuntu-latest', 'guest-arch': 'earmv7hf',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'evbarm', 'netbsd-arch': 'earmv7hf',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': false, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-riscv64 (RV64 LE): the riscv port's 64-bit default; 64-bit inlines atomics.
  { leg: 'netbsd-riscv64', os: 'ubuntu-latest', 'guest-arch': 'riscv64',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'riscv',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': false, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    // SHIPPED 2026-07-24 (publish:true): revived and proven green (twice) after
    // fixupLibuvRiscvCpuRelax — uv__cpu_relax hand-encoded the RISC-V PAUSE as
    // `.insn 0x0100000f`, which the netbsd-10 riscv assembler predates; the fixup
    // emits the identical bytes via `.word`. A deterministic cross-build (no flaky
    // qemu), so it earns a hard release gate like earmv7hf. Ships as
    // clode-<ver>-netbsd10.1-riscv64. soft-fail is stripped from publishers on the
    // release tier (so the release requires it green); it stays soft on the CI
    // on-ramp. no-exec: a green cross leg means it compiled + linked.
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // netbsd-mips64eb (MIPS64 BIG-endian): the sbmips port; 64-bit inlines atomics,
  // no shim. canonical-LE bytecode proof on a 3rd 64-bit-BE target.
  { leg: 'netbsd-mips64eb', os: 'ubuntu-latest', 'guest-arch': 'mips64eb',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'sbmips', 'netbsd-arch': 'mips64eb',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': false, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    // REVIVED 2026-07-24 (ci:true, soft-fail) via OPTION 1: the blessed full
    // `build.sh distribution`, with a one-line NetBSD-src fixup for the sbmips
    // wall. mips64eb's failure was never our engine — distribution died building
    // usr.sbin/crash ("unknown type name 'bool'" in sys/arch/mips/include/
    // systemsw.h, which isn't self-contained). netbsd-crossbuild patches that
    // header (sbmips-scoped) before distribution, so the known-complete sysroot
    // path builds unchanged. The lighter compose-your-own sysroot path was
    // explored (it got METALOG + includes working; csu was the next wall) and
    // DEFERRED to the backlog as its own project — see BACKLOG.md. Cross-built +
    // no-exec: green = it compiled and linked. SHIPPED 2026-07-27: proven green
    // (run 30258990845) alongside i386/riscv64 — a deterministic cross-build (no
    // flaky qemu) earns a hard release gate like them. Ships as
    // clode-<ver>-netbsd10.1-mips64eb; soft-fail is stripped from publishers on the
    // release tier (release requires it green), stays soft on the CI on-ramp.
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // NOTE: netbsd-vax was dropped 2026-07-18 — a confirmed ENGINE wall, not just a
  // toolchain risk: build.sh produces a working vax toolchain but quickjs fails to
  // compile (deps/quickjs/dtoa.c, VAX's non-IEEE-754 float format). Not worth a
  // soft-fail leg; revisit only if the engine gains VAX float support.
  // netbsd-sh3el (Renesas SuperH SH-3, LE 32-bit): the evbsh3 port; 32-bit → shim.
  { leg: 'netbsd-sh3el', os: 'ubuntu-latest', 'guest-arch': 'sh3el',
    'netbsd-src': 'netbsd-10', 'netbsd-machine': 'evbsh3', 'netbsd-arch': 'sh3el',
    'cross-file': 'scripts/netbsd.toolchain.cmake',
    'atomic-shim': true, tier2: true, verify: 'none', 'no-exec': true,
    floor: '10.1', 'guest-version': '10.1',
    publish: true, ci: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    fidelity: { tier: 0 } },
  // ---- Cosmopolitan APE leg (Task 4b, spike/quickjs/results/cosmo-fidelity-run.md):
  // ONE fat (x86-64 + aarch64) Actually Portable Executable that runs native on
  // Linux/macOS/Windows/BSD — ADDED beside the tjs legs, never a replacement.
  // build-tjs.mjs's CLODE_TJS_TARGET=cosmo provisions cosmocc 4.0.2, forces the
  // lean profile, applies patches/libuv-cosmo.patch + patches/libtjs-cosmo.patch,
  // and builds the tjs-cli APE via scripts/cosmo.toolchain.cmake (the `cosmo: true`
  // marker routes build-leg down that path). The cross "toolchain" is cosmocc,
  // self-provisioned by build-tjs (NOT a Docker cross-image), so no cross-image/
  // cross-apt; wasm/mimalloc/ffi off (none build under cosmocc). Built on ubuntu:
  // Linux execs the APE, so the builder fuses + PONGs on the runner, and the SAME
  // .com is then exercised on macOS/Windows/BSD runners (PONG + attest each — the
  // multi-OS fan-out; see BACKLOG "Cosmopolitan APE leg" → PHASE E CI note).
  // SHIPPING (2026-07-31, maintainer call: "release worthy as is, we'll improve it
  // over time as needed"). Graduated from the publish:false + soft-fail onboarding
  // after the full agentic fidelity suite came back green on the APE at parity with
  // native tjs (mcp-ws, tools 5/5, node-shim-agentic, workflow, subagent-diff) plus
  // interactive render/resize/live-turn. Dropping `soft-fail` is REQUIRED, not
  // incidental: the ci-tier invariant in test/tjs-legs.test.cjs enforces "if we ship
  // it, CI gates it", so a published leg may not be soft-fail. Consequence, accepted:
  // a cosmo regression now turns main RED instead of being tolerated. Ships UNSIGNED
  // as clode-<ver>-cosmo.com (canonical-name.cjs); the Gatekeeper/quarantine note is
  // a release-notes item. Large timeout: the first build downloads cosmocc (441MB) +
  // compiles the full lean tree; the tjs-cache keys on recipe so repeat builds are cheap.
  { leg: 'cosmo', os: 'ubuntu-latest', cosmo: true,
    'cross-file': 'scripts/cosmo.toolchain.cmake',
    publish: true, ci: true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off',
    // ONE .com, many hosts. Built on ubuntu-latest and driven interactively on
    // darwin-arm64 -- which means the platform we BUILD it on is one we have
    // never driven it on. Declared explicitly so each host earns its own tier.
    // Documentation-derived (no build/tjs/cosmo artifact and no local cosmocc
    // toolchain to inspect as of this commit) — see commit message.
    runTargets: [
      'cosmo-linux-x86-64', 'cosmo-linux-aarch64',
      'cosmo-macos-x86-64', 'cosmo-macos-aarch64',
      'cosmo-windows-x86-64',
      'cosmo-freebsd-x86-64', 'cosmo-openbsd-x86-64', 'cosmo-netbsd-x86-64',
    ],
    // Per-run-target map (fidelityFor reads l.fidelity[runTarget]): the leg
    // BUILDS on ubuntu-latest, but the only place the .com has actually been
    // DRIVEN is darwin-arm64 -- tier 0 everywhere else, including
    // cosmo-linux-x86-64, the build host itself. "Likely works off-mac" is not
    // evidence.
    fidelity: {
      // MAINTAINER RULING 2026-08-04: tier 1 requires all six FLOOR_ROWS
      // green (no partial credit), so tier 0 is correct at 4/6.
      // CORRECTED 2026-08-04 (understated): the cited source
      // (spike/quickjs/results/cosmo-fidelity-run.md sec.3) has TWO arms, and
      // only the native CONTROL arm had been mined — for darwin-arm64's rows.
      // The cosmo SUBJECT arm passed the SAME 7/7 scenarios (Write, Grep,
      // Bash-inline, 2-tool loop, PreToolUse hook, --continue, Workflow), plus
      // a Bash round-trip against the actual fused quaude.com. Reading a
      // document's control arm and ignoring its subject arm understated the
      // very platform the run was ABOUT. B1/C1/G7 backfilled from it (B4 was
      // already recorded), so the floor now reads 4/6 — identical to
      // darwin-arm64, from the same run, as it should be.
      // floorCoverage('cosmo-macos-aarch64') derives this from RESULTS.md.
      'cosmo-macos-aarch64': { tier: 0, date: '2026-07-30', bundle: '2.1.218', how: 'primary-darwin',
                               note: 'floor 4/6 green (B1,B4,C1,G7); A1,D1 not driven; H1/H3/H4/H7 + F6/D6/G2 also pass (not floor rows) — see RESULTS.md' },
      // Was: "BUILD host. Never driven." — false under the 2026-08-04 ruling.
      // The build host is the ONE place the .com is actually executed: the leg
      // fuses it and runs the PONG smoke there. That earns G7 here and nowhere
      // else in this map — the other seven hosts inherit nothing.
      'cosmo-linux-x86-64':  { tier: 0, date: '2026-08-02', how: 'ci',
                               note: 'floor 1/6 green (G7 — the build-pipeline PONG smoke, run on the ubuntu build host); A1,B1,B4,C1,D1 not driven — see RESULTS.md' },
      'cosmo-linux-aarch64':  { tier: 0 },
      'cosmo-macos-x86-64':   { tier: 0 },
      'cosmo-windows-x86-64': { tier: 0 },
      'cosmo-freebsd-x86-64': { tier: 0 },
      'cosmo-openbsd-x86-64': { tier: 0 },
      'cosmo-netbsd-x86-64':  { tier: 0 },
    } },
];

export function legsFor(tier) {
  if (tier === 'release') {
    // DETERMINISTIC RELEASE CONTENTS (user doctrine 2026-07-14: slow releases
    // over non-deterministic contents). A release publishes a FIXED manifest —
    // every publishing leg. soft-fail is a CI concept (a flaky new leg must not
    // block per-push CI); on the release tier it would let a TCG/qemu flake
    // silently DROP a declared asset, so two runs of the same commit could ship
    // different sets. Strip it from PUBLISHERS: the release job's `needs: [leg]`
    // then requires the whole matrix green (rerun-failed the flakes), and
    // if-no-files-found:error guarantees a green leg produced its asset. Legs
    // that publish nothing (engine-only darwin-x86/ppc) KEEP soft-fail — they add
    // no asset, so a flake there must not block the release. Demote a
    // chronically-flaky publisher explicitly (drop publish), never silently.
    // ciOnly legs (the glibc canary) are CI-only: they ship nothing today, so they
    // must not appear in — let alone gate — a release. Filter them out here; they
    // stay in the ci tier below. (When a musl-less Linux arch makes glibc a real
    // publisher, drop its `ciOnly` and give it `publish:true`.)
    return LEGS.filter((l) => !l.ciOnly).map(({ ci, ciOnly, 'ci-os': _o, 'ci-guest-version': _v, ...leg }) => {
      if (leg.publish) delete leg['soft-fail'];
      return leg;
    });
  }
  if (tier === 'ci') {
    return LEGS.filter((l) => l.ci).map(({ ci, publish, ciOnly, 'ci-os': ciOs, 'ci-guest-version': ciVer,
      'macos-min': _mm, 'macos-sdk': _ms, 'macos-arch': _ma, 'cross-image': _ci, ...leg }) => {
      if (ciOs) leg.os = ciOs;                          // ci rides the newest runner/guest
      if (ciVer) leg['guest-version'] = ciVer;
      // House rule: new-to-CI VM legs earn hard status. But a leg we SHIP has
      // already earned it — IF WE PUBLISH IT, CI GATES IT (user, 2026-07-17).
      // This used to soft-fail every VM leg regardless of publish, so ten shipped
      // platforms (netbsd/freebsd/openbsd/dragonfly/omnios/solaris/midnightbsd/
      // haiku/netbsd-sparc/netbsd-m68k) could regress on main in total silence and
      // only bite at release, where the SAME leg is hard (the release tier strips
      // soft-fail from publishers — see its comment above; this is that doctrine,
      // applied one tier earlier). That is not hypothetical: haiku-x64 broke at
      // 9e968b4 and CI shrugged for three commits (BACKLOG "Known shipped-artifact
      // bugs"). A silent regression is indistinguishable from working code.
      // The cost is real and accepted: a qemu/cpa infra flake on a shipped leg now
      // reddens CI. That is the cheaper failure — rerun a flake; you cannot rerun
      // a regression you were never told about. Demote a chronically-flaky
      // publisher by dropping `publish` (an explicit decision to stop shipping it),
      // never by quietly softening its gate.
      // DELETE, not just "don't add": four publishers (midnightbsd, haiku,
      // netbsd-sparc, netbsd-m68k) carry an explicit `soft-fail: true` in their
      // LEGS entry from when they were new, so merely skipping the VM default
      // would leave them soft. Same shape as the release tier's
      // `if (leg.publish) delete leg['soft-fail']`.
      if (publish) delete leg['soft-fail'];
      else if (VM(leg)) leg['soft-fail'] = true;
      return leg;
    });
  }
  throw new Error(`unknown tier '${tier}' (release | ci)`);
}

// CLI: tjs-legs.mjs <tier> [only-leg] [guest-version-override] [macos-min-override]
// The optional args back the tjs-legs.yml workflow_dispatch probe (the
// version-floor walk): pick ONE leg out of the tier, optionally at an
// overridden guest version — or, for the darwin floor walk, an overridden
// deployment target (same bisect ritual, different version axis). Probes
// never publish.
// The four darwin slices — release.yml runs them as a SEPARATE job (only:darwin)
// so the darwin-universal lipo waits ONLY on them, not the whole matrix (incl. the
// slow NetBSD fleet). The rest run as only:notdarwin. Keep in sync with the
// universal's four-arch contract.
export const DARWIN_SLICES = ['darwin-arm64', 'darwin-x64', 'darwin-x86', 'darwin-ppc'];

// A published ARTIFACT's run-targets, not a build leg's name. These differ for
// exactly two artifacts, and both differences have already misled us:
//   - darwin-universal lipo's four publish:false slices into ONE shipped binary
//   - cosmo is one .com, built on ubuntu-latest, that claims many host OSes
// Keying coverage on `publish: true` omits the darwin slices entirely — including
// darwin-arm64, the only platform we drive daily.
export function runTargetsFor(leg) {
  return leg.runTargets ? [...leg.runTargets] : [leg.leg];
}

export function publishedRunTargets() {
  const out = new Set(DARWIN_SLICES); // shipped inside darwin-universal
  for (const l of legsFor('release')) {
    if (l.publish) for (const rt of runTargetsFor(l)) out.add(rt);
  }
  return [...out].sort();
}

// A run-target's fidelity lives on the leg that PRODUCES it. Darwin slices are
// publish:false legs whose run-targets ship inside darwin-universal, so they
// declare here like any other. This is a RECORDING of what has actually been
// driven (test/fidelity/RESULTS.md is the evidence) -- tier 0 is the honest
// default and a legitimate answer; a leg with no `fidelity` at all is silence,
// not a claim, and returns null (the tests below treat that as a defect).
export function fidelityFor(runTarget) {
  for (const l of legsFor('release')) {
    if (!l.fidelity) continue;
    if (runTargetsFor(l).includes(runTarget)) {
      return l.fidelity[runTarget] || (l.fidelity.tier !== undefined ? l.fidelity : null);
    }
  }
  return null;
}

// The floor: the six RECIPE rows a run-target must clear GREEN, ALL SIX, to
// earn fidelity tier 1 (maintainer ruling 2026-08-04: tier 1 keeps its strict
// meaning, no partial credit). Defined in exactly one place; floorCoverage
// below and the fidelity notes both read from here, not a second declared list.
export const FLOOR_ROWS = ['A1', 'B1', 'B4', 'C1', 'D1', 'G7'];

// SECTION-AWARE parse of test/fidelity/RESULTS.md. Rows are read ONLY from the
// results table: collection starts at that table's `| --- |` separator and
// STOPS at the next `##` heading. RESULTS.md has an `## Attempted, not
// evidence` section (a quarantined, contaminated run), and a "starts with | 2"
// test would have silently counted any table row parked there — the ledger
// would grade itself on evidence it had already disqualified. Exported so a
// test can feed it synthetic text; floorCoverage() below is its only caller in
// this file.
export function parseResultsRows(text) {
  const rows = [];
  let started = false;
  for (const line of text.split('\n')) {
    if (/^\s*##/.test(line)) {
      if (started) break;    // the results table ended at this heading
      continue;
    }
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 7) continue;
    if (cells.every((c) => /^-+$/.test(c))) { started = true; continue; } // the separator opens the table
    if (!started) continue;                                               // header (or stray prose pipe)
    const [date, rt, row, engine, bundle, verdict, note] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({ date, rt, row, engine, bundle, verdict, note, idx: rows.length });
  }
  return rows;
}

// Derived, not declared (repo doctrine — memory: "dep closure: derived, not
// declared"): floor coverage for a run-target is computed by reading
// test/fidelity/RESULTS.md directly, not by a second hand-maintained list in
// this file that could drift from the evidence.
//
// LATEST WINS. For a given (run-target, floor row) the row with the newest
// DATE decides (file order breaks a tie), and it counts as green only on an
// exact `pass`. The old "any pass anywhere wins" rule made a recorded
// REGRESSION inert: append a `fail` for a row that once passed and coverage
// would not budge, so the ledger could only ever look better than reality. A
// later fail now takes the coverage away, which is the whole point of writing
// failures down.
export function floorCoverage(runTarget) {
  const resultsPath = fileURLToPath(new URL('../test/fidelity/RESULTS.md', import.meta.url));
  const latest = new Map();
  for (const r of parseResultsRows(readFileSync(resultsPath, 'utf8'))) {
    if (r.rt !== runTarget || !FLOOR_ROWS.includes(r.row)) continue;
    const prev = latest.get(r.row);
    if (!prev || r.date > prev.date || (r.date === prev.date && r.idx > prev.idx)) latest.set(r.row, r);
  }
  const green = new Set([...latest.values()].filter((r) => r.verdict === 'pass').map((r) => r.row));
  return {
    green: FLOOR_ROWS.filter((r) => green.has(r)),
    missing: FLOOR_ROWS.filter((r) => !green.has(r)),
  };
}

export function cli(tier, only, versionOverride, macosMinOverride) {
  let legs = legsFor(tier);
  if (only === 'darwin') {
    legs = legs.filter((l) => DARWIN_SLICES.includes(l.leg));       // the universal's ingredients
  } else if (only === 'notdarwin') {
    legs = legs.filter((l) => !DARWIN_SLICES.includes(l.leg));      // everything else
  } else if (only) {
    legs = legs.filter((l) => l.leg === only);                     // single-leg probe (floor walk)
    if (!legs.length) throw new Error(`no such leg in tier '${tier}': ${only}`);
    legs = legs.map((l) => ({ ...l, publish: false }));            // probes never publish
  }
  if (versionOverride) legs = legs.map((l) => ({ ...l, 'guest-version': versionOverride }));
  if (macosMinOverride) legs = legs.map((l) => ({ ...l, 'macos-min': macosMinOverride }));
  // The emitted JSON goes straight to strategy.matrix.include, and every field
  // name IS a matrix key. `fidelity` (an object) and `runTargets` (an array)
  // are the first NON-SCALAR values in the manifest, and tjs-legs.yml's `leg`
  // job has no `name:` — so GHA composes each job's display name from the
  // matrix values, and those display names are exactly what branch-protection
  // rules match. A serialized object landing in a required check's name would
  // rename the check (and break the protection rule) on every ledger edit.
  // Both fields are LEDGER metadata, not build inputs: strip them here, the
  // same way legsFor() strips ci-os / ci-guest-version. fidelityFor() and the
  // tests read them via a direct import, never from this JSON.
  return legs.map(({ fidelity, runTargets, ...leg }) => leg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(cli(process.argv[2], process.argv[3], process.argv[4], process.argv[5])));
}

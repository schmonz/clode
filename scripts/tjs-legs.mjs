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

const LEGS = [
  // ---- T1 native runners
  // Naming (user decision 2026-07-10): tjs builders own the CANONICAL name
  // clode-<ver>-<platform>; the transitional Node-SEA binaries carry the
  // -node engine tag instead.
  // macos-14 = the oldest arm64 runner GitHub hosts (= the publish floor);
  // ci rides the newest (macos-26).
  { leg: 'darwin-arm64', os: 'macos-14', 'ci-os': 'macos-26', publish: true, ci: true, floor: '11.0' },
  // glibc Linux artifacts are smoke-only forever (Decision 3): the published
  // Linux artifacts are the musl-static ones. Release pins the oldest hosted
  // ubuntu (glibc floor for the smoke build), ci the newest.
  { leg: 'linux-x64-glibc', os: 'ubuntu-22.04', 'ci-os': 'ubuntu-26.04', publish: false, ci: true },
  { leg: 'linux-arm64-glibc', os: 'ubuntu-22.04-arm', 'ci-os': 'ubuntu-26.04-arm', publish: false, ci: true },
  // ---- T1.5 Alpine musl-static (the published Linux artifacts)
  { leg: 'linux-x64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'x86_64',
    static: true, publish: true, ci: true },  // ci: per-push twin of THE published Linux artifact
  { leg: 'linux-arm64-musl', os: 'ubuntu-24.04-arm', 'guest-platform': 'alpine', 'guest-arch': 'aarch64',
    static: true, publish: true },            // alpine container on the arm runner
  { leg: 'linux-s390x-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 's390x',
    static: true, wasm: 'off',                // WAMR's MAP_32BIT is x86/ARM-only; undefined on s390x
    publish: true, smoke: 'version',          // PONG-class smoke lives in the be-oracle job
    timeout: 300, 'soft-fail': true },        // slow qemu-user BE leg — non-blocking (plan T1.5)
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
  { leg: 'darwin-x64', os: 'macos-15-intel', publish: true,
    'macos-min': '10.6', 'macos-sdk': '10.6', floor: '10.6',
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
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
  { leg: 'darwin-x86', os: 'macos-15-intel', publish: false,
    'macos-min': '10.4', 'macos-sdk': '10.4u', 'macos-arch': 'i386', floor: '10.4',
    'no-exec': true, wasm: 'off', mimalloc: 'off', ffi: 'off',
    'soft-fail': true },
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
  { leg: 'darwin-ppc', os: 'ubuntu-latest', publish: false,
    'macos-min': '10.4', 'macos-arch': 'ppc', floor: '10.4',
    // renovate: datasource=docker depName=ghcr.io/variantxyz/gcc-powerpc-apple-darwin8
    'cross-image': 'ghcr.io/variantxyz/gcc-powerpc-apple-darwin8@sha256:a9013745ae4a696dc3a047675a85e7c43b9453cdb1e26d9a7ac9738587c1e198',
    // cross-file defaults to scripts/darwin-ppc.toolchain.cmake; the image
    // bakes its toolchain so cross-apt stays empty. atomic-shim: the 32-bit-BE
    // __atomic_*_8 link wall (formerly hardcoded in the exec=cross step, now a
    // per-leg field so the tier-2 Debian cross legs can turn it off).
    'atomic-shim': true,
    'no-exec': true, wasm: 'off', mimalloc: 'off', ffi: 'off',
    'soft-fail': true },
  // windows-x64 (native engine leg): compiles tjs.exe ON windows-latest with
  // MSVC cl.exe (CLODE_TJS_WIN_MSVC — the Activate-MSVC-dev-env step +
  // ilammy/msvc-dev-cmd), so build-leg's exec=host machinery does build +
  // fuse + PONG in ONE windows job (like darwin) and PUBLISHES
  // clode-<ver>-windows-x64 the normal exec=host way. The canonical Windows
  // leg — a hard gate (a broken publisher must fail red). Same
  // wasm/mimalloc/ffi-off config as the other floor legs. The finer shim +
  // sync-primitive signals run in ci.yml's windows-x64-tests job against this
  // leg's tjs-windows-x64 artifact. (Phase B: cl.exe proven on the transient
  // windows-x64-msvc leg, then flipped in as the canonical compiler and that
  // leg deleted — mingw is retired.)
  { leg: 'windows-x64', os: 'windows-latest', msvc: true, publish: true, ci: true,
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
  // windows-arm64 (the Windows finale): native MSVC ARM64 on the windows-11-arm
  // runner (msvc-arch:arm64 → the dev-env's cl targets ARM64), exec=host build +
  // fuse + PONG like windows-x64. PUBLISHES clode-<ver>-windows-arm64 — the asset
  // the release.yml tripwire requires (Phase 4 dropped the SEA arm64 leg). Proven
  // green first try (cl.exe de-risked the build), now a HARD publisher like
  // windows-x64. Finer signals run in ci.yml's windows-arm64-tests job.
  { leg: 'windows-arm64', os: 'windows-11-arm', msvc: true, 'msvc-arch': 'arm64',
    publish: true, ci: true, wasm: 'off', mimalloc: 'off', ffi: 'off' },
  // ---- T1.5 extra musl arches. x86 execs natively on the x64 kernel (full
  // smoke); the rest are qemu-user with version-smoke like s390x. wasm off:
  // MAP_32BIT is x86_64/aarch64-only in musl headers — and 32-bit WAMR is
  // worthless to us anyway.
  { leg: 'linux-x86-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'x86',
    static: true, wasm: 'off', publish: true },  // 32-bit LE
  { leg: 'linux-armv7-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'armv7',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true },  // qemu-user (Cobalt runners lack aarch32 EL0)
  { leg: 'linux-ppc64le-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'ppc64le',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true },  // qemu-user
  { leg: 'linux-riscv64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'riscv64',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true },  // qemu-user
  { leg: 'linux-loongarch64-musl', os: 'ubuntu-latest', 'guest-platform': 'alpine', 'guest-arch': 'loongarch64',
    static: true, wasm: 'off', publish: true, smoke: 'version', timeout: 300, 'soft-fail': true },  // qemu-user (alpine >= 3.21)
  // ---- T2 VM legs: fuse + smoke run INSIDE the guest (exec=guest —
  // BSD/illumos binaries have no binfmt escape on a Linux host). Config:
  // wasm off (WAMR "linux"-platform mremap wall on every non-Linux POSIX),
  // mimalloc off (NetBSD compile regression; start uniform, re-enable
  // per-platform as legs prove), ffi off (spares a guest libffi dep; nothing
  // shipped imports tjs:ffi). Engine config (quickjs + wurl + libuv)
  // identical to the pinned oracle build.
  { leg: 'netbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'netbsd',
    // PROVEN floor (probe run 29160710037, honest build, 304 compile lines;
    // 10.0 also proven, run 29160710641). 9.2 is DISQUALIFIED operationally:
    // its guest wedged 89 min at pkgin install (dead-mirror-class hang for
    // the 9.2-era repo path) until the 90-min wall — regardless of whether
    // the build would have succeeded. NetBSD's COMPAT machinery carries a
    // 9.4-built artifact forward across 10.x.
    'guest-version': '9.4',
    // renovate: datasource=custom.cpa-netbsd-x86-64 depName=netbsd-x86-64-guest versioning=loose
    'ci-guest-version': '10.1',
    'guest-packages': 'cmake gmake nodejs git-base bash', floor: '9.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'freebsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'freebsd',
    // PROVEN floor (probe run 29157832721, honest in-guest build): 14.0 is
    // the oldest whose pkg repos still exist — 12.x/13.x died with their
    // branches at EOL (probes failed before any build). FreeBSD symbol
    // versioning gives 14.0-built binaries forward-compat across 14.x/15.x.
    'guest-version': '14.0',
    // renovate: datasource=custom.cpa-freebsd-x86-64 depName=freebsd-x86-64-guest versioning=loose
    'ci-guest-version': '15.1',
    'guest-packages': 'cmake gmake node git bash', floor: '14.0',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  // OpenBSD is EXEMPT from publish-oldest: ld.so refuses on libc.so major
  // mismatch and majors bump nearly every release, in BOTH directions
  // (probe evidence: the 7.9-built tjs died on 7.6 with "can't load library
  // libc.so") — so an old-built artifact serves only that one old release
  // and breaks everyone current. Publish the newest instead; 7.6 is proven
  // to BUILD (probe run 29157832086, honest build) but a 7.6 artifact would
  // be useless to 7.9 users.
  { leg: 'openbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-version': '7.9',
    'guest-packages': 'cmake gmake node git bash', floor: '7.9',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'dragonflybsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'dragonflybsd', 'guest-version': '6.4.2',
    'guest-packages': 'cmake gmake node git bash', floor: '6.4.2',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'omnios-amd64', os: 'ubuntu-latest', 'guest-platform': 'omnios',
    'guest-version': 'r151056',        // PROVEN floor (probe run 29154489454, 2026-07-11) — oldest in cpa catalog
    // renovate: datasource=custom.cpa-omnios-x86-64 depName=omnios-x86-64-guest versioning=loose
    'ci-guest-version': 'r151058',
    'guest-packages': 'developer/gcc14 developer/build/gnu-make ooce/developer/cmake ooce/runtime/node-22 developer/versioning/git shell/bash',
    floor: 'r151056',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM (illumos rung)
  { leg: 'solaris-amd64', os: 'ubuntu-latest', 'guest-platform': 'solaris',
    'guest-version': '11.4-gcc',       // CBE image with gcc/g++ preinstalled
    // renovate: datasource=custom.vmactions-solaris depName=solaris-guest versioning=loose
    'ci-guest-version': '11.4-gcc-14', // same OS, newer image+toolchain (variants: renovate.json allowedVersions pins /gcc/)
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git runtime/nodejs shell/bash',
    floor: '11.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,
    timeout: 120 },               // vmactions boot is slower than cpa
  // ---- Sweep 2 (2026-07-10): the remaining easy adds on proven machinery.
  // BSD arm64 = cpa's other architecture (TCG on GitHub runners — no
  // /dev/kvm — hence the long timeouts); MidnightBSD + Haiku = cpa's
  // remaining x86-64 catalog; OpenIndiana = the third illumos flavor via
  // vmactions (the __sun fixups transfer). All soft-fail until they earn
  // hard status.
  { leg: 'netbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'netbsd', 'guest-arch': 'arm64',
    'guest-version': '10.1', 'guest-packages': 'cmake gmake nodejs git-base bash', floor: '10.1',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'freebsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'freebsd', 'guest-arch': 'arm64',
    'guest-version': '14.4', 'guest-packages': 'cmake gmake node git bash', floor: '14.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'openbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-arch': 'arm64',
    'guest-version': '7.9', 'guest-packages': 'cmake gmake node git bash', floor: '7.9',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'midnightbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'midnightbsd', 'guest-version': '4.0.4',
    // no git: the 4.0.4 mport tree's git dep chain is broken (p5-Digest-HMAC
    // wants perl >= 5.40.3, image ships 5.38.5 — dispatch #14); every cmake
    // git usage is if(GIT_EXECUTABLE)-guarded, so the build does not need it.
    'guest-packages': 'cmake gmake node bash', floor: '4.0.4',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true },  // cpa, KVM (mport packages)
  { leg: 'haiku-x64', os: 'ubuntu-latest', 'guest-platform': 'haiku', 'guest-version': 'r1beta5',
    // HaikuPorts ships exactly ONE node: nodejs20 (user-verified, 2026-07-10)
    // — named explicitly; v20 clears the build floor (lowered to 20 for
    // OpenIndiana the same day). cmd:X provides-syntax for the rest
    // ("nodejs" alone: Name not found, #14).
    'guest-packages': 'cmd:cmake cmd:gcc nodejs20 cmd:git cmd:make', floor: 'r1beta5',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true },  // cpa, KVM (a genuinely new OS rung)
  { leg: 'openindiana-amd64', os: 'ubuntu-latest', 'guest-platform': 'openindiana',
    // PROVEN floor (probe run 29154489921, 2026-07-11) — oldest vmactions
    // conf; build-essential image. Release-only leg (illumos distro twin):
    // no ci newest-end, so no split and no Renovate pin — the weekly watcher
    // guards this floor's existence.
    'guest-version': '202510-build',
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git shell/bash runtime/nodejs',
    floor: '202510',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 120, 'soft-fail': true },  // vmactions (3rd illumos flavor)
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
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
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
    publish: true, 'soft-fail': true, timeout: 1800,
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
    publish: true, 'soft-fail': true, timeout: 1800,
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
    publish: true, 'soft-fail': true, timeout: 3600,
    wasm: 'off', mimalloc: 'off', ffi: 'off' },
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
    return LEGS.map(({ ci, 'ci-os': _o, 'ci-guest-version': _v, ...leg }) => {
      if (leg.publish) delete leg['soft-fail'];
      return leg;
    });
  }
  if (tier === 'ci') {
    return LEGS.filter((l) => l.ci).map(({ ci, publish, 'ci-os': ciOs, 'ci-guest-version': ciVer,
      'macos-min': _mm, 'macos-sdk': _ms, 'macos-arch': _ma, 'cross-image': _ci, ...leg }) => {
      if (ciOs) leg.os = ciOs;                          // ci rides the newest runner/guest
      if (ciVer) leg['guest-version'] = ciVer;
      if (VM(leg)) leg['soft-fail'] = true;  // house rule: new-to-CI VM legs earn hard status
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
export function cli(tier, only, versionOverride, macosMinOverride) {
  let legs = legsFor(tier);
  if (only) {
    legs = legs.filter((l) => l.leg === only);
    if (!legs.length) throw new Error(`no such leg in tier '${tier}': ${only}`);
    legs = legs.map((l) => ({ ...l, publish: false }));
  }
  if (versionOverride) legs = legs.map((l) => ({ ...l, 'guest-version': versionOverride }));
  if (macosMinOverride) legs = legs.map((l) => ({ ...l, 'macos-min': macosMinOverride }));
  return legs;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(cli(process.argv[2], process.argv[3], process.argv[4], process.argv[5])));
}

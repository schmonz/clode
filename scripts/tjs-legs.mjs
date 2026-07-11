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
  { leg: 'darwin-arm64', os: 'macos-14', 'ci-os': 'macos-26', publish: true, ci: true },
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
  { leg: 'darwin-x64', os: 'macos-15-intel', publish: true },  // deferred from phase 1
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
  { leg: 'netbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'netbsd', 'guest-version': '10.1',
    'guest-packages': 'cmake gmake nodejs git-base bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'freebsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'freebsd', 'guest-version': '14.4',
    // renovate: datasource=custom.cpa-freebsd-x86-64 depName=freebsd-x86-64-guest versioning=loose
    'ci-guest-version': '15.1',
    'guest-packages': 'cmake gmake node git bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'openbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-version': '7.9',
    'guest-packages': 'cmake gmake node git bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'dragonflybsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'dragonflybsd', 'guest-version': '6.4.2',
    'guest-packages': 'cmake gmake node git bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM
  { leg: 'omnios-amd64', os: 'ubuntu-latest', 'guest-platform': 'omnios', 'guest-version': 'r151058',
    'guest-packages': 'developer/gcc14 developer/build/gnu-make ooce/developer/cmake ooce/runtime/node-22 developer/versioning/git shell/bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true },  // cpa, KVM (illumos rung)
  { leg: 'solaris-amd64', os: 'ubuntu-latest', 'guest-platform': 'solaris',
    'guest-version': '11.4-gcc',       // CBE image with gcc/g++ preinstalled
    // renovate: datasource=custom.vmactions-solaris depName=solaris-guest versioning=loose
    'ci-guest-version': '11.4-gcc-14', // same OS, newer image+toolchain (variants: renovate.json allowedVersions pins /gcc/)
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git runtime/nodejs shell/bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, ci: true,
    timeout: 120 },               // vmactions boot is slower than cpa
  // ---- Sweep 2 (2026-07-10): the remaining easy adds on proven machinery.
  // BSD arm64 = cpa's other architecture (TCG on GitHub runners — no
  // /dev/kvm — hence the long timeouts); MidnightBSD + Haiku = cpa's
  // remaining x86-64 catalog; OpenIndiana = the third illumos flavor via
  // vmactions (the __sun fixups transfer). All soft-fail until they earn
  // hard status.
  { leg: 'netbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'netbsd', 'guest-arch': 'arm64',
    'guest-version': '10.1', 'guest-packages': 'cmake gmake nodejs git-base bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'freebsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'freebsd', 'guest-arch': 'arm64',
    'guest-version': '14.4', 'guest-packages': 'cmake gmake node git bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'openbsd-arm64', os: 'ubuntu-latest', 'guest-platform': 'openbsd', 'guest-arch': 'arm64',
    'guest-version': '7.9', 'guest-packages': 'cmake gmake node git bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 300, 'soft-fail': true },  // cpa, TCG
  { leg: 'midnightbsd-amd64', os: 'ubuntu-latest', 'guest-platform': 'midnightbsd', 'guest-version': '4.0.4',
    // no git: the 4.0.4 mport tree's git dep chain is broken (p5-Digest-HMAC
    // wants perl >= 5.40.3, image ships 5.38.5 — dispatch #14); every cmake
    // git usage is if(GIT_EXECUTABLE)-guarded, so the build does not need it.
    'guest-packages': 'cmake gmake node bash',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true },  // cpa, KVM (mport packages)
  { leg: 'haiku-x64', os: 'ubuntu-latest', 'guest-platform': 'haiku', 'guest-version': 'r1beta5',
    // HaikuPorts ships exactly ONE node: nodejs20 (user-verified, 2026-07-10)
    // — named explicitly; v20 clears the build floor (lowered to 20 for
    // OpenIndiana the same day). cmd:X provides-syntax for the rest
    // ("nodejs" alone: Name not found, #14).
    'guest-packages': 'cmd:cmake cmd:gcc nodejs20 cmd:git cmd:make',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, 'soft-fail': true, ci: true },  // cpa, KVM (a genuinely new OS rung)
  { leg: 'openindiana-amd64', os: 'ubuntu-latest', 'guest-platform': 'openindiana',
    'guest-version': '202604-build',  // build-essential image
    'guest-packages': 'developer/build/cmake developer/build/gnu-make developer/versioning/git shell/bash runtime/nodejs',
    wasm: 'off', mimalloc: 'off', ffi: 'off', publish: true, timeout: 120, 'soft-fail': true },  // vmactions (3rd illumos flavor)
];

export function legsFor(tier) {
  if (tier === 'release') {
    return LEGS.map(({ ci, 'ci-os': _o, 'ci-guest-version': _v, ...leg }) => leg);
  }
  if (tier === 'ci') {
    return LEGS.filter((l) => l.ci).map(({ ci, publish, 'ci-os': ciOs, 'ci-guest-version': ciVer, ...leg }) => {
      if (ciOs) leg.os = ciOs;                          // ci rides the newest runner/guest
      if (ciVer) leg['guest-version'] = ciVer;
      if (VM(leg)) leg['soft-fail'] = true;  // house rule: new-to-CI VM legs earn hard status
      return leg;
    });
  }
  throw new Error(`unknown tier '${tier}' (release | ci)`);
}

// CLI: tjs-legs.mjs <tier> [only-leg] [guest-version-override]
// The optional args back the tjs-legs.yml workflow_dispatch probe (the
// version-floor walk): pick ONE leg out of the tier, optionally at an
// overridden guest version. Probes never publish.
export function cli(tier, only, versionOverride) {
  let legs = legsFor(tier);
  if (only) {
    legs = legs.filter((l) => l.leg === only);
    if (!legs.length) throw new Error(`no such leg in tier '${tier}': ${only}`);
    legs = legs.map((l) => ({ ...l, publish: false }));
  }
  if (versionOverride) legs = legs.map((l) => ({ ...l, 'guest-version': versionOverride }));
  return legs;
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(cli(process.argv[2], process.argv[3], process.argv[4])));
}

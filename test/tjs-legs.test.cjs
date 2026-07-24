'use strict';
// The tjs leg manifest (scripts/tjs-legs.mjs) is the single source of truth
// both GHA workflows consume (user decision 2026-07-11: no duplicated leg
// definitions between the per-push and release builds, and per-push CI must
// exercise EVERY OS in the release matrix — one arch each; arch twins are
// slow and add little signal). These invariants keep the two tiers honest:
//   1. release tier still contains every published leg (golden name list —
//      an accidental drop is a release regression, not a refactor).
//   2. ci tier covers every OS (guest-platform ∪ native) the release tier
//      builds, exactly one leg per OS.
//   3. ci never publishes/attests, and a ci VM leg is soft-fail ONLY if we do not
//      ship it (house rule: new-to-CI legs earn hard status — but shipping IS the
//      earning, so if we publish it, CI gates it).
//   4. a ci leg's engine config (static/wasm/mimalloc/ffi/guest-version/
//      guest-packages) is byte-identical to its release sibling — CI must
//      smoke what the release will ship, not a variant.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const legsFor = (tier, only) => JSON.parse(
  execFileSync(process.execPath,
    [path.join(REPO, 'scripts', 'tjs-legs.mjs'), tier, ...(only ? [only] : [])], { encoding: 'utf8' }));

test('release tier splits cleanly into darwin / notdarwin (universal decoupling)', () => {
  const all = legsFor('release').map((l) => l.leg).sort();
  const darwin = legsFor('release', 'darwin').map((l) => l.leg).sort();
  const notdarwin = legsFor('release', 'notdarwin').map((l) => l.leg).sort();
  // darwin = exactly the 4 slices
  assert.deepStrictEqual(darwin, ['darwin-arm64', 'darwin-ppc', 'darwin-x64', 'darwin-x86']);
  // notdarwin excludes every darwin leg
  assert.ok(!notdarwin.some((n) => n.startsWith('darwin-')), 'notdarwin must contain no darwin slice');
  // the two are a partition of the whole tier (no leg lost, none double-counted)
  assert.deepStrictEqual([...darwin, ...notdarwin].sort(), all,
    'darwin ∪ notdarwin must equal the whole release tier');
  assert.strictEqual(darwin.length + notdarwin.length, all.length);
});

// The OS an entry exercises: its guest platform, or the runner's own OS.
const osOf = (l) => {
  if (l.leg.startsWith('windows')) return 'windows';
  const gp = l['guest-platform'];
  if (gp && gp !== 'native') return gp === 'alpine' ? 'linux' : gp;
  return l.os.startsWith('macos') ? 'darwin' : 'linux';
};

test('every leg declares a runner os (tjs-legs.yml runs-on: matrix.os)', () => {
  // A leg without `os` yields an empty runs-on, which fails the WHOLE leg-matrix
  // expansion (not just that leg) — GHA rejects the matrix, no leg jobs run.
  // netbsd-sparc shipped without os and broke the matrix (2026-07-13); this guards it.
  for (const tier of ['release', 'ci']) {
    for (const l of legsFor(tier)) {
      assert.ok(typeof l.os === 'string' && l.os.length > 0,
        `${l.leg} (${tier}): missing runner os — empty runs-on breaks the whole leg matrix`);
    }
  }
});

test('release tier: every published leg is present (golden)', () => {
  const release = legsFor('release');
  const published = release.filter((l) => l.publish).map((l) => l.leg).sort();
  assert.deepStrictEqual(published, [
    'dragonflybsd-amd64',
    'freebsd-amd64', 'freebsd-arm64',
    'haiku-x64',
    'linux-arm64-musl', 'linux-armv7-musl', 'linux-loongarch64-musl',
    'linux-ppc64le-musl', 'linux-riscv64-musl', 'linux-s390x-musl',
    'linux-x64-musl', 'linux-x86-musl',
    'midnightbsd-amd64',
    'netbsd-alpha', 'netbsd-amd64', 'netbsd-arm64', 'netbsd-earmv7hf',
    'netbsd-hppa', 'netbsd-m68k', 'netbsd-macppc', 'netbsd-pmax',
    'netbsd-riscv64',
    'netbsd-sgimips', 'netbsd-sh3el', 'netbsd-sparc', 'netbsd-sparc64',
    'omnios-amd64', 'openbsd-amd64', 'openbsd-arm64',
    'openindiana-amd64',
    'solaris-amd64',
    'windows-arm64', 'windows-x64',
  ]);
});

test('ci tier: every release OS is exercised, exactly one leg per VM OS', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  const releaseOSes = new Set(release.map(osOf));
  const ciOSes = new Set(ci.map(osOf));
  // openindiana is the deliberate exception: the illumos distro twin of
  // omnios (same kernel family) stays release-only, like the arch twins.
  const wanted = [...releaseOSes].filter((o) => o !== 'openindiana').sort();
  assert.deepStrictEqual([...ciOSes].sort(), wanted);
  for (const os of ciOSes) {
    if (os === 'linux' || os === 'darwin') continue; // native tier keeps its historical multi-leg set
    const legs = ci.filter((l) => osOf(l) === os);
    if (os === 'windows') {
      // windows-x64 (MSVC publisher) + windows-arm64 (the finale leg). Both permanent.
      assert.deepStrictEqual(legs.map((l) => l.leg).sort(), ['windows-arm64', 'windows-x64'],
        `windows: expected the x64+arm64 pair, got ${legs.map((l) => l.leg)}`);
      continue;
    }
    assert.strictEqual(legs.length, 1, `${os}: expected exactly one ci leg, got ${legs.map((l) => l.leg)}`);
  }
});

// IF WE PUBLISH IT, CI GATES IT (user, 2026-07-17). The house rule — new-to-CI VM
// legs run soft-fail until they earn hard status — is right for a leg being
// bootstrapped and wrong for one we ship: shipping IS the earning. This used to
// soft-fail every VM leg regardless, so ten shipped platforms could regress on main
// in silence and only bite at release, where the same leg is hard. haiku-x64 did
// exactly that at 9e968b4 and CI shrugged for three commits.
//
// Both directions are asserted, because both failures are real: a shipped leg that
// goes soft hides regressions, and an unshipped experiment that goes hard blocks
// merges on a platform nobody gets. `publish` is stripped from the ci tier, so the
// release tier is the authority on what we ship.
test('ci tier: never publishes; VM legs are soft-fail UNLESS we ship that leg', () => {
  const ci = legsFor('ci');
  const shipped = new Set(legsFor('release').filter((l) => l.publish).map((l) => l.leg));
  let gated = 0;
  for (const l of ci) {
    assert.ok(!l.publish, `${l.leg}: ci must not publish`);
    const gp = l['guest-platform'];
    if (!gp || gp === 'native' || gp === 'alpine') continue;   // not a VM leg
    if (shipped.has(l.leg)) {
      assert.ok(!l['soft-fail'],
        `${l.leg}: we SHIP this leg, so CI must GATE it — a regression here must not `
        + 'land silently and ambush the release, where this same leg is hard. Stop '
        + 'shipping it (drop publish) rather than softening its gate.');
      gated++;
    } else {
      assert.strictEqual(l['soft-fail'], true, `${l.leg}: new-to-CI VM legs start soft-fail`);
    }
  }
  assert.ok(gated > 0, 'no shipped VM leg gates CI — the invariant is not being exercised');
});

test('ci legs match their release siblings byte-for-byte on engine config', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  // os and guest-version are deliberately EXCLUDED: they are the per-tier
  // version axis (user decision 2026-07-11 — ci builds the newest available
  // version of each OS, release builds/publishes from the oldest proven
  // floor). Everything that shapes the engine itself must stay identical.
  const CONFIG = ['guest-platform', 'guest-arch', 'guest-packages',
    'static', 'wasm', 'mimalloc', 'ffi', 'smoke'];
  for (const l of ci) {
    const sib = release.find((r) => r.leg === l.leg);
    if (!sib) continue; // ci-only legs (the glibc smoke pair) have no release sibling
    for (const k of CONFIG) {
      assert.deepStrictEqual(l[k], sib[k], `${l.leg}.${k}: ci=${l[k]} release=${sib[k]}`);
    }
  }
  // ...and the glibc smoke-only pair really is ci-only-or-smoke everywhere.
  for (const name of ['linux-x64-glibc', 'linux-arm64-glibc']) {
    const sib = release.find((r) => r.leg === name);
    if (sib) assert.ok(!sib.publish, `${name} must never publish (Decision 3)`);
  }
});

test('glibc legs are a CI-only canary: built in CI, filtered out of release', () => {
  // Ship only musl-static (Decision 3), so glibc gates nothing — but keep it
  // building in CI as a second-libc/dynamic-link canary AND the warm
  // glibc-dynamic path for a future musl-less Linux arch (alpha/hppa/sparc64).
  const inRel = new Set(legsFor('release').map((l) => l.leg));
  const inCi = new Set(legsFor('ci').map((l) => l.leg));
  for (const name of ['linux-x64-glibc', 'linux-arm64-glibc']) {
    assert.ok(inCi.has(name), `${name}: must build in CI (the canary)`);
    assert.ok(!inRel.has(name), `${name}: must NOT be in the release tier (smoke-only, ships nothing)`);
  }
  // the `ciOnly` marker is internal — it must not leak into either tier's output.
  // (`smoke` is a DIFFERENT, legitimate field: the qemu-user smoke MODE.)
  for (const tier of ['release', 'ci']) {
    for (const l of legsFor(tier)) {
      assert.ok(!('ciOnly' in l), `${l.leg} (${tier}): internal 'ciOnly' marker leaked into leg output`);
    }
  }
});

test('darwin floor: macos-* fields are release-only, on native-darwin or cross legs', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  // darwin-x64 is now CROSS-built via osxcross (off the deprecating Intel runner):
  // the image supplies the SDK (no macos-sdk field) and the toolchain file carries
  // the 10.6 floor; macos-min stays for the floor gate.
  const dx = release.find((l) => l.leg === 'darwin-x64');
  assert.strictEqual(dx['macos-min'], '10.6');
  assert.strictEqual(dx['cross-dockerfile'], 'ci/osxcross-darwin');
  assert.strictEqual(dx['cross-file'], 'scripts/darwin-x64.toolchain.cmake');
  for (const l of release) {
    if ('macos-min' in l || 'macos-sdk' in l || 'macos-arch' in l) {
      // macos-* floor fields belong on native-darwin (macos runner) or a darwin
      // CROSS leg on ubuntu — pinned image (darwin-ppc) or built-in-CI (x64/x86).
      const nativeDarwin = !l['guest-platform'] && l.os.startsWith('macos');
      assert.ok(nativeDarwin || 'cross-image' in l || 'cross-dockerfile' in l,
        `${l.leg}: macos-* floor fields belong only on native-darwin or cross legs`);
    }
  }
  for (const l of ci) {
    // no-exec is NOT stripped: it is a tier-invariant target fact (the
    // runner literally cannot exec the output, e.g. the darwin-x86 i386
    // floor build) — dropping it in ci would make build-leg's exec-guards
    // misfire and try to EXEC the un-execable binary.
    assert.ok(!('macos-min' in l) && !('macos-sdk' in l)
      && !('macos-arch' in l) && !('cross-image' in l),
      `${l.leg}: ci tier must strip the macos-* floor fields, cross-image`);
  }
});

test('darwin-ppc cross leg: engine-only ppc at floor 10.4, digest-pinned image', () => {
  const dp = legsFor('release').find((l) => l.leg === 'darwin-ppc');
  assert.strictEqual(dp['macos-min'], '10.4');
  assert.strictEqual(dp['macos-arch'], 'ppc');
  assert.strictEqual(dp['no-exec'], true);
  assert.strictEqual(dp.publish, false);
  assert.ok(dp['cross-image'].includes('@sha256:'), 'cross-image must be digest-pinned');
  assert.strictEqual(dp.os, 'ubuntu-latest');
});

test('darwin-ppc keeps the atomic-shim now that the exec=cross step is generalized', () => {
  // The exec=cross build step USED to hardcode CLODE_TJS_CROSS_FILE=
  // darwin-ppc.toolchain.cmake and CLODE_TJS_ATOMIC_SHIM=1. Task 2.5
  // parameterized both (so the tier-2 Debian cross legs can supply their own
  // toolchain + turn the shim off). darwin-ppc must therefore now carry
  // atomic-shim:true explicitly, or its __atomic_*_8 link wall returns.
  const dp = legsFor('release').find((l) => l.leg === 'darwin-ppc');
  assert.strictEqual(dp['atomic-shim'], true,
    'darwin-ppc must declare atomic-shim:true (was hardcoded in the exec=cross step)');
  // darwin-ppc leaves cross-file unset → the workflow default (its own file).
  assert.strictEqual(dp['cross-file'], undefined);
});

test('build-leg exec=cross step is parameterized, not darwin-ppc-hardcoded', () => {
  const action = fs.readFileSync(
    path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8');
  // The generalized step must consume the leg's cross-file + atomic-shim, not
  // literal darwin-ppc values.
  assert.ok(/CLODE_TJS_CROSS_FILE=\/w\/\$CROSS_FILE/.test(action),
    'exec=cross must use the CROSS_FILE env (inputs.cross-file), not a literal path');
  assert.ok(/CLODE_TJS_ATOMIC_SHIM=\$ATOMIC_SHIM/.test(action),
    'exec=cross must use the ATOMIC_SHIM env (inputs.atomic-shim), not a literal 1');
  assert.ok(!/CLODE_TJS_CROSS_FILE=\/w\/scripts\/darwin-ppc\.toolchain\.cmake/.test(action),
    'the darwin-ppc toolchain path must no longer be hardcoded in the build step');
});

test('release.yml: darwin-universal hard-gates (no continue-on-error) + tripwire requires it', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');
  // Isolate the darwin-universal job block (up to the next top-level 2-space job key).
  const m = wf.match(/\n {2}darwin-universal:\n([\s\S]*?)\n {2}\w[\w-]*:/);
  assert.ok(m, 'darwin-universal job block not found');
  assert.ok(!/continue-on-error:\s*true/.test(m[1]),
    'darwin-universal must NOT be continue-on-error — the universal is four arches or the release is blocked');
  // The lipo step must still hard-require all four slices present.
  assert.ok(/for a in arm64 x64 x86 ppc;.*test -f/.test(wf),
    'darwin-universal must assert all four slices exist before lipo');
  // The release gate must require the macOS universal asset (shipped as plain
  // `clode-<ver>-macos` — a Universal binary you download without picking an arch).
  assert.ok(/REQUIRED="[^"]*clode-\*-macos[^"]*"/.test(wf),
    'release tripwire must require the macOS universal asset');
});

test('darwin-x86 Tiger leg: engine-only i386 at floor 10.4', () => {
  const release = legsFor('release');
  const dt = release.find((l) => l.leg === 'darwin-x86');
  assert.strictEqual(dt['macos-min'], '10.4');
  // cross-built via legacy osxcross now — the image supplies the 10.4u SDK.
  assert.strictEqual(dt['cross-dockerfile'], 'ci/osxcross-darwin');
  assert.strictEqual(dt['cross-file'], 'scripts/darwin-x86.toolchain.cmake');
  assert.strictEqual(dt['macos-arch'], 'i386');
  assert.strictEqual(dt['no-exec'], true);
  assert.strictEqual(dt.publish, false);
  // No GitHub runner can exec the output of a no-exec leg. A no-exec leg can
  // only publish a builder when it is ALSO tier2: the cross-fuse produces the
  // foreign-arch builder WITHOUT executing it (validated later under qemu-user).
  // The engine-only floor legs (darwin-ppc, darwin-x86) are no-exec + non-tier2
  // (Mach-O needs a pre-signed template) — proven but never published.
  for (const l of release) {
    if (l['no-exec'] && !l.tier2) {
      assert.ok(!l.publish, `${l.leg}: no-exec non-tier2 legs must not publish`);
    }
  }
});

test('netbsd-sparc leg: own-qemu cross-fuse, floored at 10.1, VM leg', () => {
  const release = legsFor('release');
  const ns = release.find((l) => l.leg === 'netbsd-sparc');
  assert.ok(ns, 'netbsd-sparc leg must be present in the release tier');
  assert.strictEqual(ns['guest-platform'], 'qemu-netbsd-sparc');
  assert.strictEqual(ns['guest-arch'], 'sparc');
  assert.strictEqual(ns.floor, '10.1');
  // guest-version MUST be pinned: without it the matrix falls to the alpine
  // default '3.22' and the image-asset names format() to wd0-*-3.22 (the
  // original Wall #1 — "no assets match the file pattern"). Lock it at the floor.
  assert.strictEqual(ns['guest-version'], '10.1',
    "netbsd-sparc must pin guest-version:'10.1' or the image asset names default to alpine 3.22");
  assert.strictEqual(ns.publish, true);
  // Not soft-fail on EITHER tier now: release strips it from publishers
  // (deterministic contents — see the determinism test below), and as of
  // 2026-07-17 so does ci — if we ship it, CI gates it. This leg used to be soft
  // on ci under the VM house rule, which is how a shipped platform could regress
  // on main unheard (haiku-x64 did, at 9e968b4).
  assert.strictEqual(ns['soft-fail'], undefined, 'release publishers must not be soft-fail');
  assert.ok(ns['guest-platform'] && !['native', 'alpine'].includes(ns['guest-platform']),
    'netbsd-sparc must be recognized as a VM leg (own-qemu backend)');
  const ci = legsFor('ci').find((l) => l.leg === 'netbsd-sparc');
  assert.strictEqual(ci['soft-fail'], undefined,
    'netbsd-sparc publishes, so CI must gate it — a VM leg we ship has earned hard status');
});

test('release tier: publishing legs are NOT soft-fail (deterministic contents)', () => {
  // User doctrine 2026-07-14: slow releases over non-deterministic contents. A
  // release ships a FIXED manifest — every publisher must be green, so a
  // TCG/qemu flake fails the leg job (needs:[leg]) rather than silently dropping
  // the asset. Engine-only NON-darwin legs (linux-riscv64/s390x + the NetBSD
  // cross fleet) may stay soft — they ship no asset. The darwin slices are the
  // exception: they publish nothing individually but ARE hard (see the next
  // test) because the universal needs all four.
  for (const l of legsFor('release')) {
    if (l.publish) {
      assert.notStrictEqual(l['soft-fail'], true,
        `${l.leg}: a release PUBLISHER must not be soft-fail (would make release contents non-deterministic)`);
    }
  }
  // CI keeps soft-fail as the ON-RAMP for legs we do not ship; publishers are
  // hard in BOTH tiers. That on-ramp may legitimately be EMPTY — 2026-07-22
  // retired the last three occupants (netbsd i386/mips64eb/riscv64, ci:false)
  // after they never once built — so assert its CONTENTS, not a nonzero count:
  // a leg we SHIP must never sit on the on-ramp. The per-leg mapping itself
  // (shipped => gated, unshipped VM => soft) is enforced by the 'ci tier: never
  // publishes; VM legs are soft-fail UNLESS we ship that leg' test above.
  const shippedLegs = new Set(legsFor('release').filter((l) => l.publish).map((l) => l.leg));
  for (const l of legsFor('ci').filter((l) => l['soft-fail'] === true)) {
    assert.ok(!shippedLegs.has(l.leg),
      `${l.leg}: a SHIPPED leg must GATE ci, not sit on the soft-fail on-ramp`);
  }
});

test('release tier: all four darwin slices are HARD (universal is 4 arches or nothing)', () => {
  // The darwin release is exactly ONE artifact — clode-<ver>-macos —
  // a fat Mach-O of all four slices. None of the slices publishes on its own, but
  // every one is a REQUIRED ingredient: a missing slice must block the release,
  // not ship a 2/3-arch fat. So none may be soft-fail (unlike the non-darwin
  // engine-only legs). The universal job (release.yml) enforces the same at
  // assembly time: its lipo step exit-1's on any missing slice and is NOT
  // continue-on-error.
  const rel = legsFor('release');
  for (const name of ['darwin-arm64', 'darwin-x64', 'darwin-x86', 'darwin-ppc']) {
    const l = rel.find((x) => x.leg === name);
    assert.ok(l, `${name} slice leg must exist`);
    assert.strictEqual(l.publish, false, `${name}: a darwin slice ships via the universal, never on its own`);
    assert.notStrictEqual(l['soft-fail'], true,
      `${name}: darwin slices are HARD — the universal is four arches or it is not release-ready`);
  }
});

test('linux-riscv64 leg: Debian-cross tier-2, qemu-user verified, publishes', () => {
  const l = legsFor('release').find((x) => x.leg === 'linux-riscv64');
  assert.ok(l, 'linux-riscv64 leg must be present');
  assert.strictEqual(l['guest-arch'], 'riscv64');
  assert.strictEqual(l.verify, 'qemu-user');
  assert.strictEqual(l['no-exec'], true, 'cross leg cannot exec the target on the runner');
  assert.strictEqual(l.tier2, true, 'tier2 emits the cross-fused builder (smoke artifact)');
  assert.strictEqual(l.publish, false, 'glibc-dynamic no-floor — proves the machinery; musl-static twin ships (Decision 3)');
  assert.strictEqual(l['atomic-shim'], false, 'riscv64 has native 64-bit atomics');
  assert.ok(l['cross-image'], 'exec=cross needs a cross-image');
  assert.ok(l['cross-file'] && /riscv64/.test(l['cross-file']), 'must point at the riscv64 toolchain file');
  assert.ok(/riscv64/.test(l['cross-apt'] || ''), 'cross-apt must install the riscv64 gcc');
});

test('linux-s390x leg: 64-bit BE Debian-cross tier-2, qemu-user verified (canonical-LE proof)', () => {
  const l = legsFor('release').find((x) => x.leg === 'linux-s390x');
  assert.ok(l, 'linux-s390x leg must be present');
  assert.strictEqual(l['guest-arch'], 's390x');
  assert.strictEqual(l.verify, 'qemu-user');
  assert.strictEqual(l['no-exec'], true);
  assert.strictEqual(l.tier2, true);
  assert.strictEqual(l.publish, false, 'glibc-dynamic no-floor — proves the machinery; musl-static twin ships (Decision 3)');
  assert.strictEqual(l['atomic-shim'], false, 's390x has native 64-bit atomics');
  assert.ok(/s390x/.test(l['cross-file'] || ''), 'must point at the s390x toolchain file');
  assert.ok(/s390x/.test(l['cross-apt'] || ''), 'cross-apt must install the s390x gcc');
});

test('netbsd-m68k leg: NetBSD build.sh cross, tier-2 built-not-run', () => {
  const l = legsFor('release').find((x) => x.leg === 'netbsd-m68k');
  assert.ok(l, 'netbsd-m68k leg must be present');
  assert.strictEqual(l['guest-arch'], 'm68k');
  assert.strictEqual(l.verify, 'none', 'NetBSD has no qemu-user — built-not-run');
  assert.strictEqual(l['no-exec'], true);
  assert.strictEqual(l.tier2, true);
  assert.strictEqual(l.publish, true);
  assert.strictEqual(l['atomic-shim'], true, 'm68k lacks 8-byte libatomic');
  assert.notStrictEqual(l['netbsd-src'], undefined, 'must pin a NetBSD src rev for build.sh');
  assert.ok(l['netbsd-machine'], 'must name an m68k NetBSD port for build.sh -m');
  assert.ok(/m68k/.test(l['cross-file'] || ''), 'must point at the m68k toolchain file');
  assert.strictEqual(l.floor, '10.1');
  // No cross-image: this cross leg builds its toolchain via build.sh, not a
  // docker image.
  assert.strictEqual(l['cross-image'], undefined);
});

test('netbsd-sparc64 fleet leg: generic toolchain, 64-bit BE, tier-2 built-not-run', () => {
  const l = legsFor('release').find((x) => x.leg === 'netbsd-sparc64');
  assert.ok(l, 'netbsd-sparc64 leg must be present');
  assert.strictEqual(l['guest-arch'], 'sparc64');
  assert.strictEqual(l['netbsd-machine'], 'sparc64');
  assert.strictEqual(l['cross-file'], 'scripts/netbsd.toolchain.cmake',
    'fleet legs use the GENERIC toolchain (triple discovered from the tooldir)');
  assert.strictEqual(l['atomic-shim'], false, 'sparc64 is 64-bit — inlines atomics, no shim');
  assert.strictEqual(l.verify, 'none');
  assert.strictEqual(l.tier2, true);
  assert.notStrictEqual(l['netbsd-src'], undefined);
});

// Both run per-push for early warning on the build.sh cross path; they differ on
// whether they GATE, and the discriminator is shipping, not the build path:
// netbsd-m68k publishes (so CI gates it — 2026-07-17), netbsd-sparc64 does not yet
// (so it stays non-blocking under the VM house rule). "build.sh cross is
// non-blocking" was the old reason m68k was soft; shipping an artifact overrides it.
test('NetBSD build.sh cross legs (m68k, sparc64) run per-push in CI; the shipped one gates', () => {
  const ci = legsFor('ci');
  const shipped = new Set(legsFor('release').filter((x) => x.publish).map((x) => x.leg));
  for (const name of ['netbsd-m68k', 'netbsd-sparc64']) {
    const l = ci.find((x) => x.leg === name);
    assert.ok(l, `${name} must be in the ci tier (early warning on the cross path)`);
    if (shipped.has(name)) {
      assert.strictEqual(l['soft-fail'], undefined,
        `${name} publishes, so CI must gate it (if we ship it, CI gates it)`);
    } else {
      assert.strictEqual(l['soft-fail'], true,
        `${name} ships nothing yet, so it must stay non-blocking in CI`);
    }
    assert.ok(l['netbsd-src'], `${name} must route through build.sh (netbsd-src)`);
  }
});

test('build-leg cache key carries the macos floor axes', () => {
  // Same lesson as the version-blind key that restored a 7.9-built tjs
  // into a 7.6 probe: a floor-blind key would smoke a stock-SDK binary.
  const action = fs.readFileSync(
    path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8');
  const keyLine = action.split('\n').find((ln) => ln.trim().startsWith('key: tjs-'));
  assert.ok(keyLine.includes('inputs.macos-min') && keyLine.includes('inputs.macos-sdk'),
    `cache key must carry the macos floor axes, got: ${keyLine}`);
});

test('floored legs carry a name-safe floor; unfloored do not', () => {
  const release = legsFor('release');
  const FLOORED_OS = /^(darwin|netbsd|freebsd|openbsd|dragonflybsd|midnightbsd|omnios|solaris|openindiana|haiku)/;
  for (const l of release) {
    const isFlooredOs = FLOORED_OS.test(l.leg);
    if (l.floor !== undefined) {
      assert.match(l.floor, /^[A-Za-z0-9.]+$/, `${l.leg}: floor '${l.floor}' must be name-safe`);
      assert.ok(isFlooredOs, `${l.leg}: only floored-OS legs may carry a floor`);
    }
    // every PUBLISHED floored-OS leg must declare a floor
    if (l.publish && isFlooredOs) {
      assert.ok(l.floor, `${l.leg}: published floored-OS leg must declare a floor`);
    }
    // unfloored published legs must NOT carry a floor
    if (l.publish && !isFlooredOs) {
      assert.strictEqual(l.floor, undefined, `${l.leg}: unfloored leg must not carry a floor`);
    }
  }
});

test('floor survives the ci-tier destructure (build-leg needs it for the smoke asset name)', () => {
  const ci = legsFor('ci');
  const rel = legsFor('release');
  for (const l of ci) {
    const sib = rel.find((r) => r.leg === l.leg);
    if (sib && sib.floor !== undefined) {
      assert.strictEqual(l.floor, sib.floor, `${l.leg}: ci tier must not strip/alter floor`);
    }
  }
});

test('version policy: ci rides the newest end, release the oldest floor', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  const rel = (n) => release.find((l) => l.leg === n);
  const cin = (n) => ci.find((l) => l.leg === n);
  // The ci-os / ci-guest-version override mechanics, pinned to the known
  // ends from the 2026-07-11 catalog sweep. When a catalog moves, the
  // freshness checker (scripts/check-guest-versions.mjs) flags it and these
  // pins move with the manifest.
  assert.strictEqual(rel('darwin-arm64').os, 'macos-14');       // oldest hosted arm64 = publish floor
  assert.strictEqual(cin('darwin-arm64').os, 'macos-26');       // newest hosted arm64
  // glibc is a CI-only canary (absent from release); ci still rides the newest.
  assert.strictEqual(rel('linux-x64-glibc'), undefined, 'glibc is ciOnly — not in the release tier');
  assert.strictEqual(cin('linux-x64-glibc').os, 'ubuntu-26.04');
  assert.strictEqual(rel('freebsd-amd64')['guest-version'], '14.0');  // proven floor (oldest with living pkg repos)
  assert.strictEqual(cin('freebsd-amd64')['guest-version'], '15.1');  // newest in cpa catalog
  // ci-* keys never leak into emitted matrices.
  for (const l of [...release, ...ci]) {
    assert.ok(!('ci-os' in l) && !('ci-guest-version' in l), `${l.leg}: ci-* override keys must be stripped`);
  }
});

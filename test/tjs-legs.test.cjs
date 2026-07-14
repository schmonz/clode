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
//   3. ci never publishes/attests, and every ci VM leg is soft-fail (house
//      rule: new-to-CI legs earn hard status).
//   4. a ci leg's engine config (static/wasm/mimalloc/ffi/guest-version/
//      guest-packages) is byte-identical to its release sibling — CI must
//      smoke what the release will ship, not a variant.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const legsFor = (tier) => JSON.parse(
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'tjs-legs.mjs'), tier], { encoding: 'utf8' }));

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
    'darwin-arm64', 'darwin-x64',
    'dragonflybsd-amd64',
    'freebsd-amd64', 'freebsd-arm64',
    'haiku-x64',
    'linux-arm64-musl', 'linux-armv7-musl', 'linux-loongarch64-musl',
    'linux-ppc64le-musl', 'linux-riscv64', 'linux-riscv64-musl',
    'linux-s390x', 'linux-s390x-musl',
    'linux-x64-musl', 'linux-x86-musl',
    'midnightbsd-amd64',
    'netbsd-amd64', 'netbsd-arm64', 'netbsd-m68k', 'netbsd-sparc',
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

test('ci tier: never publishes, VM legs are soft-fail', () => {
  const ci = legsFor('ci');
  for (const l of ci) {
    assert.ok(!l.publish, `${l.leg}: ci must not publish`);
    const gp = l['guest-platform'];
    if (gp && gp !== 'native' && gp !== 'alpine') {
      assert.strictEqual(l['soft-fail'], true, `${l.leg}: new-to-CI VM legs start soft-fail`);
    }
  }
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

test('darwin floor: macos-min/macos-sdk are release-only, native-darwin-only', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  // The darwin analog of the guest-version floor policy: release builds
  // against the pinned old SDK (the proven floor), ci rides the runner's
  // stock SDK (the newest end).
  const dx = release.find((l) => l.leg === 'darwin-x64');
  assert.strictEqual(dx['macos-min'], '10.6');
  assert.strictEqual(dx['macos-sdk'], '10.6');
  for (const l of release) {
    if ('macos-min' in l || 'macos-sdk' in l || 'macos-arch' in l) {
      // Native darwin legs run on a macos runner; the cross leg (darwin-ppc)
      // builds a darwin target on ubuntu inside a toolchain image.
      const nativeDarwin = !l['guest-platform'] && l.os.startsWith('macos');
      assert.ok(nativeDarwin || 'cross-image' in l,
        `${l.leg}: macos-* floor fields belong only on native-darwin or cross-image legs`);
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

test('darwin-x86 Tiger leg: engine-only i386 at floor 10.4', () => {
  const release = legsFor('release');
  const dt = release.find((l) => l.leg === 'darwin-x86');
  assert.strictEqual(dt['macos-min'], '10.4');
  assert.strictEqual(dt['macos-sdk'], '10.4u');
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
  // On the RELEASE tier a publisher is NOT soft-fail (deterministic contents —
  // see the determinism test below). On CI it IS soft-fail (VM house rule).
  assert.strictEqual(ns['soft-fail'], undefined, 'release publishers must not be soft-fail');
  assert.ok(ns['guest-platform'] && !['native', 'alpine'].includes(ns['guest-platform']),
    'netbsd-sparc must be recognized as a VM leg (own-qemu backend)');
  const ci = legsFor('ci').find((l) => l.leg === 'netbsd-sparc');
  assert.strictEqual(ci['soft-fail'], true, 'on CI, netbsd-sparc is soft-fail (VM house rule)');
});

test('release tier: publishing legs are NOT soft-fail (deterministic contents)', () => {
  // User doctrine 2026-07-14: slow releases over non-deterministic contents. A
  // release ships a FIXED manifest — every publisher must be green, so a
  // TCG/qemu flake fails the leg job (needs:[leg]) rather than silently dropping
  // the asset. Only engine-only legs (publish:false: darwin-x86/ppc) may stay
  // soft — they ship no asset.
  for (const l of legsFor('release')) {
    if (l.publish) {
      assert.notStrictEqual(l['soft-fail'], true,
        `${l.leg}: a release PUBLISHER must not be soft-fail (would make release contents non-deterministic)`);
    }
  }
  // CI keeps soft-fail (that's the on-ramp for new legs); the two tiers differ
  // here on purpose.
  const ciSoft = legsFor('ci').filter((l) => l['soft-fail'] === true);
  assert.ok(ciSoft.length > 0, 'CI tier still uses soft-fail for its VM legs');
});

test('linux-riscv64 leg: Debian-cross tier-2, qemu-user verified, publishes', () => {
  const l = legsFor('release').find((x) => x.leg === 'linux-riscv64');
  assert.ok(l, 'linux-riscv64 leg must be present');
  assert.strictEqual(l['guest-arch'], 'riscv64');
  assert.strictEqual(l.verify, 'qemu-user');
  assert.strictEqual(l['no-exec'], true, 'cross leg cannot exec the target on the runner');
  assert.strictEqual(l.tier2, true, 'tier2 emits + uploads the cross-fused builder');
  assert.strictEqual(l.publish, true);
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
  assert.strictEqual(l.publish, true);
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
  assert.strictEqual(rel('linux-x64-glibc').os, 'ubuntu-22.04');
  assert.strictEqual(cin('linux-x64-glibc').os, 'ubuntu-26.04');
  assert.strictEqual(rel('freebsd-amd64')['guest-version'], '14.0');  // proven floor (oldest with living pkg repos)
  assert.strictEqual(cin('freebsd-amd64')['guest-version'], '15.1');  // newest in cpa catalog
  // ci-* keys never leak into emitted matrices.
  for (const l of [...release, ...ci]) {
    assert.ok(!('ci-os' in l) && !('ci-guest-version' in l), `${l.leg}: ci-* override keys must be stripped`);
  }
});

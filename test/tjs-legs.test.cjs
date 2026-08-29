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

// `legsFor` above is the EMITTED matrix (what tjs-legs.yml feeds
// strategy.matrix.include) — deliberately stripped of the non-scalar ledger
// fields. `legsDirect` is the manifest itself; ledger assertions must read it,
// not the matrix JSON.
const { runTargetsFor, publishedRunTargets, DARWIN_SLICES, fidelityFor, floorCoverage,
  FLOOR_ROWS, parseResultsRows, legsFor: legsDirect } = require('../scripts/tjs-legs.mjs');

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
    // cosmo graduated from onboarding to a SHIPPING leg 2026-07-31 (maintainer call).
    // One fat APE for Linux/macOS/Windows/BSD, shipped unsigned as clode-<ver>-cosmo.com.
    'cosmo',
    'dragonflybsd-amd64',
    'freebsd-amd64', 'freebsd-arm64',
    // haiku-x64 RESTORED 2026-08-27, exactly as the removal note said to: "put it back
    // the moment the leg can install packages again". vmactions/haiku-vm v1.1.5 added
    // r1beta6 and dropped r1beta5, so an image and a live package repo finally coexist.
    'haiku-x64',
    'linux-arm64-musl', 'linux-armv7-musl', 'linux-loongarch64-musl',
    'linux-ppc64le-musl', 'linux-riscv64-musl', 'linux-s390x-musl',
    'linux-x64-musl', 'linux-x86-musl',
    'midnightbsd-amd64',
    'netbsd-alpha', 'netbsd-amd64', 'netbsd-arm64', 'netbsd-earmv7hf',
    'netbsd-hppa', 'netbsd-i386', 'netbsd-m68k', 'netbsd-macppc', 'netbsd-mips64eb', 'netbsd-pmax',
    'netbsd-riscv64',
    'netbsd-sgimips', 'netbsd-sh3el', 'netbsd-sparc', 'netbsd-sparc64',
    'omnios-amd64', 'openbsd-amd64', 'openbsd-arm64',
    'openindiana-amd64',
    'solaris-amd64',
    'windows-amd64', 'windows-arm64',
  ]);
});

test('ci tier: every release OS is exercised, exactly one leg per VM OS', () => {
  const release = legsFor('release');
  const ci = legsFor('ci');
  const releaseOSes = new Set(release.map(osOf));
  const ciOSes = new Set(ci.map(osOf));
  // TWO DECLARED EXCEPTIONS, and the second one shows the rule is the wrong shape.
  //
  // openindiana: the illumos distro twin of omnios (same kernel family), release-only
  // like the arch twins. NOTE it PUBLISHES, so under the rule this file states
  // elsewhere — "if we ship it, CI gates it" — it should not be exempt at all.
  //
  // haiku: dropped from ci 2026-08-25 (user). It publishes NOTHING (publish:false,
  // demoted while cross-platform-actions has no beta6 guest image), so while the
  // blocker stands the leg can only re-derive an answer already written down, at the
  // cost of a runner slot per push. The question we actually want answered — has a
  // beta6 image appeared? — is asked daily by scripts/haiku-image-watch.mjs instead.
  //
  // THE RULE SHOULD BE A PROPERTY, NOT A LIST: every OS with a PUBLISHING leg must be
  // exercised in CI. Under that rule haiku is correctly exempt (it ships nothing) and
  // openindiana is NOT (it ships). Adopting it today would turn this red for
  // openindiana — which is a real finding, filed under the push-CI/tag-release matrix
  // item in BACKLOG, not something to fix in passing before a release.
  // haiku LEFT this set on 2026-08-27 when it went back to publish:true. Under the
  // property this comment argues for — every OS with a PUBLISHING leg is exercised in CI
  // — a shipping haiku must not be exempt, so it is not. openindiana remains the one leg
  // that ships without CI coverage, which is still the real finding filed under the
  // push-CI/tag-release matrix item in BACKLOG.
  // THE RULE IS NOW A PROPERTY, WITH NO EXEMPTIONS: every OS with a PUBLISHING leg is
  // exercised in CI. This set held openindiana and haiku, and the comment above argued
  // at length that openindiana "should not be exempt at all" — while exempting it by
  // name. That is a rule enforced by a list rather than by the rule.
  //
  // Both left on 2026-08-27: haiku when it returned to publish:true, openindiana when it
  // gained ci:true, which it had never had. Release-only meant nothing touched
  // openindiana between tags, so an image or package-repo drift would have surfaced
  // DURING a release — and three third-party package repos misbehaved that same day.
  //
  // KEEP THIS EMPTY. An entry here means something ships without CI gating it.
  const CI_EXEMPT = new Set([]);
  const wanted = [...releaseOSes].filter((o) => !CI_EXEMPT.has(o)).sort();
  assert.deepStrictEqual([...ciOSes].sort(), wanted);
  for (const os of ciOSes) {
    if (os === 'linux' || os === 'darwin') continue; // native tier keeps its historical multi-leg set
    const legs = ci.filter((l) => osOf(l) === os);
    if (os === 'windows') {
      // windows-amd64 (MSVC publisher) + windows-arm64 (the finale leg). Both permanent.
      assert.deepStrictEqual(legs.map((l) => l.leg).sort(), ['windows-amd64', 'windows-arm64'],
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

test('the 10.4-floor darwin legs declare darwin-poll:true (Tiger kqueue event-drop)', () => {
  // Darwin 8's kqueue drops socket/pipe/SIGCHLD/async delivery under the fused
  // runtime's fd load (ktrace-confirmed on real Tiger PPC), so both 10.4-floor
  // legs build libuv's generic poll(2) backend instead. darwin-x64 (10.6) and
  // darwin-arm64 keep kqueue — they are proven, including on real Mavericks.
  const legs = legsFor('release');
  for (const name of ['darwin-ppc', 'darwin-x86']) {
    const l = legs.find((x) => x.leg === name);
    assert.ok(l, `${name} leg missing`);
    assert.strictEqual(l['darwin-poll'], true,
      `${name} is a 10.4-floor leg and must declare darwin-poll:true`);
    assert.strictEqual(l.floor, '10.4',
      `${name}: darwin-poll is only for the 10.4 floor`);
  }
  for (const name of ['darwin-x64', 'darwin-arm64']) {
    const l = legs.find((x) => x.leg === name);
    assert.ok(l, `${name} leg missing`);
    assert.notStrictEqual(l['darwin-poll'], true,
      `${name} must keep kqueue — poll is the old-Darwin fallback, not the default`);
  }
});

test('build-leg exec=cross step forwards darwin-poll as CLODE_TJS_DARWIN_POLL', () => {
  const action = fs.readFileSync(
    path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8');
  assert.ok(/DARWIN_POLL: \$\{\{ inputs\.darwin-poll == 'true' && '1' \|\| '0' \}\}/.test(action),
    'the cross step must derive DARWIN_POLL from inputs.darwin-poll');
  assert.ok(/-e DARWIN_POLL/.test(action),
    'DARWIN_POLL must be passed into the docker run environment');
  assert.ok(/export CLODE_TJS_DARWIN_POLL=\$DARWIN_POLL/.test(action),
    'the in-container script must export CLODE_TJS_DARWIN_POLL');
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/tjs-legs.yml'), 'utf8');
  assert.ok(/darwin-poll: \$\{\{ matrix\.darwin-poll && 'true' \|\| 'false' \}\}/.test(wf),
    'tjs-legs.yml must pass the matrix darwin-poll field to build-leg');
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
  assert.strictEqual(l['cross-file'], 'scripts/netbsd.toolchain.cmake',
    'fleet legs use the GENERIC toolchain (triple discovered from the tooldir)');
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

// RATCHET (2026-08-27): netbsd-m68k was the last leg still naming a bespoke
// toolchain file, months after scripts/netbsd.toolchain.cmake was written to
// subsume every per-arch one ("the fleet adds an arch by naming a port, not by
// writing a toolchain file"). Nothing failed — the two files were equivalent
// bar a hardcoded triple — so the leftover was invisible until a hand audit
// went looking. This asserts the invariant directly, so the NEXT bespoke file
// fails here instead of surviving until someone thinks to check.
test('every NetBSD cross leg shares the ONE generic toolchain file', () => {
  const cross = legsFor('release').filter(
    (l) => /^netbsd-/.test(l.leg) && l['cross-file'] !== undefined);
  assert.ok(cross.length >= 12, `expected the NetBSD fleet, found ${cross.length}`);
  const odd = cross.filter((l) => l['cross-file'] !== 'scripts/netbsd.toolchain.cmake');
  assert.deepStrictEqual(odd.map((l) => `${l.leg}=${l['cross-file']}`), [],
    'the generic file discovers the triple from the tooldir and serves every '
    + 'MACHINE_ARCH — a per-arch toolchain file needs a written reason here first');
});
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

test('published run-targets include the darwin slices (publish:false, shipped in the universal)', () => {
  const rts = publishedRunTargets();
  for (const slice of DARWIN_SLICES) {
    assert.ok(rts.includes(slice),
      `${slice} is publish:false but ships inside darwin-universal — it MUST be a published run-target`);
  }
});

test('publishedRunTargets covers every publish:true leg', () => {
  const rts = new Set(publishedRunTargets());
  // legsDirect, not the emitted matrix: cli() strips runTargets (it is not a
  // build input), so the matrix JSON would make cosmo look like one run-target.
  for (const l of legsDirect('release').filter((l) => l.publish)) {
    for (const rt of runTargetsFor(l)) {
      assert.ok(rts.has(rt), `${l.leg}: run-target ${rt} missing from publishedRunTargets()`);
    }
  }
});

test('runTargetsFor defaults to the leg name and honours an explicit list', () => {
  assert.deepStrictEqual(runTargetsFor({ leg: 'haiku-x64' }), ['haiku-x64']);
  assert.deepStrictEqual(runTargetsFor({ leg: 'x', runTargets: ['a', 'b'] }), ['a', 'b']);
});

// A run-target's fidelity is a RECORDING of what has actually been driven, not an
// aspiration — see test/fidelity/RESULTS.md (the evidence) and RECIPE.md (the rows).
// tier 0 is the honest default and a legitimate answer; silence is not.
test('every published run-target declares a fidelity tier', () => {
  for (const rt of publishedRunTargets()) {
    const f = fidelityFor(rt);
    assert.ok(f, `${rt}: no fidelity declaration. tier 0 is a fine answer; silence is not.`);
    assert.ok([0, 1, 2].includes(f.tier), `${rt}: tier must be 0, 1 or 2 (got ${f.tier})`);
  }
});

test('a tier>=1 claim carries its provenance', () => {
  for (const rt of publishedRunTargets()) {
    const f = fidelityFor(rt);
    if (f.tier >= 1) {
      assert.ok(f.date, `${rt}: tier ${f.tier} needs a date`);
      assert.ok(f.bundle, `${rt}: tier ${f.tier} needs the bundle it was driven against`);
      assert.ok(f.how, `${rt}: tier ${f.tier} needs a rig id from PLATFORMS.md (or "ci")`);
    }
  }
});

// MAINTAINER RULING 2026-08-04: tier 1 keeps its STRICT meaning -- all six
// FLOOR_ROWS (A1,B1,B4,C1,D1,G7) green, no partial credit for a 4/6 or 1/6
// platform. floorCoverage() DERIVES this from test/fidelity/RESULTS.md (not a
// second hand-maintained list -- doctrine: derived, not declared), so this
// invariant makes tier inflation impossible: a tier can only rise once
// RESULTS.md actually carries all six pass rows for that run-target. Hand-editing
// a tier upward without adding the rows fails this test.
test('tier claims are consistent with derived floor coverage (tier>=1 iff all six floor rows are green)', () => {
  for (const rt of publishedRunTargets()) {
    const f = fidelityFor(rt);
    const { green, missing } = floorCoverage(rt);
    if (missing.length === 0) {
      assert.ok(f.tier >= 1,
        `${rt}: floor fully covered (${FLOOR_ROWS.join(',')}) but declared tier is ${f.tier}`);
    } else {
      assert.strictEqual(f.tier, 0,
        `${rt}: floor coverage incomplete (green: ${green.join(',') || 'none'}; `
        + `missing: ${missing.join(',')}) so tier must be 0, but declared tier is ${f.tier}`);
    }
  }
});

test('cosmo declares its run-targets explicitly — one .com, many hosts', () => {
  const cosmo = legsDirect('release').find((l) => l.leg === 'cosmo');
  assert.ok(cosmo.runTargets && cosmo.runTargets.length > 1,
    'cosmo ships one .com for many hosts; a single run-target would let it inherit ' +
    'its ubuntu-latest build hosts credibility for platforms nobody has run it on');
  for (const rt of cosmo.runTargets) {
    assert.match(rt, /^cosmo-[a-z0-9]+-[a-z0-9-]+$/, `${rt}: expected cosmo-<os>-<arch>`);
  }
});

// Mirrors the existing golden published-leg list: a tier change must be a
// deliberate, reviewable edit and never silent drift. Generated with:
//   node --input-type=module -e "import {publishedRunTargets, fidelityFor} \
//     from './scripts/tjs-legs.mjs'; const m={}; for(const rt of \
//     publishedRunTargets()) m[rt]=fidelityFor(rt).tier; \
//     console.log(JSON.stringify(m,null,4));"
// As of 2026-08-04 every one of the 47 published run-targets is tier 0 (Tier
// 1 is now STRICT -- all six FLOOR_ROWS green -- and no run-target clears
// that bar yet). That is the true state, not a placeholder.
test('golden ledger: the full run-target -> tier map', () => {
  const ledger = Object.fromEntries(publishedRunTargets().map((rt) => [rt, fidelityFor(rt).tier]));
  assert.deepStrictEqual(ledger, {
    'cosmo-freebsd-x86-64': 0,
    'cosmo-linux-aarch64': 0,
    'cosmo-linux-x86-64': 0,
    'cosmo-macos-aarch64': 0,
    'cosmo-macos-x86-64': 0,
    'cosmo-netbsd-x86-64': 0,
    'cosmo-openbsd-x86-64': 0,
    'cosmo-windows-x86-64': 0,
    // The first run-target ever to clear all six FLOOR_ROWS (2026-08-09).
    'darwin-arm64': 1,
    'darwin-ppc': 0,
    'darwin-x64': 0,
    'darwin-x86': 0,
    'dragonflybsd-amd64': 0,
    'freebsd-amd64': 0,
    'freebsd-arm64': 0,
    // haiku-x64 came back 2026-08-27 with the leg, exactly as the removal note said:
    // "comes back here when the leg does". 0 is its honest floor coverage — the
    // demotion withdrew its fidelity rows in RESULTS.md and nothing has re-driven them
    // on the vmactions/beta6 backend yet. A number here would be a claim we have not
    // earned; 0 says "shipping, not yet measured", which is true.
    'haiku-x64': 0,
    'linux-arm64-musl': 0,
    'linux-armv7-musl': 0,
    'linux-loongarch64-musl': 0,
    'linux-ppc64le-musl': 0,
    'linux-riscv64-musl': 0,
    'linux-s390x-musl': 0,
    'linux-x64-musl': 0,
    'linux-x86-musl': 0,
    'midnightbsd-amd64': 0,
    'netbsd-alpha': 0,
    'netbsd-amd64': 0,
    // Cleared all six FLOOR_ROWS 2026-08-21, after its engine was rebuilt from
    // current sources (the 2026-08-09 0/5 was a stale-engine artifact).
    'netbsd-arm64': 1,
    'netbsd-earmv7hf': 0,
    'netbsd-hppa': 0,
    'netbsd-i386': 0,
    'netbsd-m68k': 0,
    'netbsd-macppc': 0,
    'netbsd-mips64eb': 0,
    'netbsd-pmax': 0,
    'netbsd-riscv64': 0,
    'netbsd-sgimips': 0,
    'netbsd-sh3el': 0,
    'netbsd-sparc': 0,
    'netbsd-sparc64': 0,
    'omnios-amd64': 0,
    'openbsd-amd64': 0,
    'openbsd-arm64': 0,
    'openindiana-amd64': 0,
    'solaris-amd64': 0,
    'windows-arm64': 0,
    // Cleared all six FLOOR_ROWS on REAL Windows, 2026-08-09.
    'windows-amd64': 1,
  });
});

// The ledger's own completeness. Without this, a new published artifact could
// ship with no declaration and no test would notice -- which is the silence
// this whole phase exists to end. DARWIN_SLICES are publish:false legs whose
// run-targets ship inside darwin-universal, so they are declared but never
// individually "published" by legsFor('release') -- carve them out rather
// than requiring published.has(rt) for them.
test('every declared run-target is actually published, and vice versa', () => {
  const declared = new Set();
  for (const l of legsDirect('release')) {
    if (!l.fidelity) continue;
    for (const rt of runTargetsFor(l)) declared.add(rt);
    // ...and the KEYS of a per-run-target fidelity map, not just the
    // run-targets the leg claims. Iterating runTargetsFor() alone let a
    // fidelity entry for a run-target this leg does not produce (a typo, a
    // renamed target, a copy-paste from another leg) sit in the manifest
    // forever: fidelityFor() would never return it and no test would look at
    // it. A flat declaration is `{tier, ...}`; a per-run-target map has
    // no `tier` of its own and its keys ARE run-target names.
    if (l.fidelity.tier !== undefined) continue;
    const claimed = new Set(runTargetsFor(l));
    for (const rt of Object.keys(l.fidelity)) {
      assert.ok(claimed.has(rt),
        `${l.leg}: fidelity declares '${rt}', which is not one of its run-targets `
        + `(${[...claimed].join(', ')}) — a bogus key is dead metadata nothing reads`);
      declared.add(rt);
    }
  }
  const published = new Set(publishedRunTargets());
  for (const rt of published) {
    assert.ok(declared.has(rt), `${rt} is published but undeclared`);
  }
  for (const rt of declared) {
    if (!published.has(rt)) {
      // A DEMOTED leg also declares without publishing: it still builds (and so
      // still has fidelity history worth keeping) but ships no artifact. That is
      // the deliberate escape hatch from tjs-legs.mjs — "demote a chronically-flaky
      // publisher explicitly (drop publish), never silently" — and it must not read
      // as a stale declaration. Derived from the legs themselves, so a leg that is
      // re-promoted needs no edit here.
      const demoted = new Set(
        legsFor('release').filter((l) => l.publish === false).flatMap((l) => runTargetsFor(l)));
      assert.ok(DARWIN_SLICES.includes(rt) || demoted.has(rt),
        `${rt} is declared but not published — stale declaration?`);
    }
  }
});

// The emitted JSON IS strategy.matrix.include, and tjs-legs.yml's `leg` job has
// no `name:` — GHA builds each job's display name out of the matrix values, and
// those names are what branch protection matches. A serialized object/array in
// there would rename required checks on every ledger edit. fidelity/runTargets
// are ledger metadata; they must never leave cli().
test('the emitted matrix carries only scalars — no fidelity, no runTargets', () => {
  for (const tier of ['release', 'ci']) {
    for (const l of legsFor(tier)) {
      assert.ok(!('fidelity' in l), `${l.leg} (${tier}): 'fidelity' leaked into the emitted matrix`);
      assert.ok(!('runTargets' in l), `${l.leg} (${tier}): 'runTargets' leaked into the emitted matrix`);
      for (const [k, v] of Object.entries(l)) {
        assert.ok(v === null || typeof v !== 'object',
          `${l.leg} (${tier}): matrix key '${k}' is non-scalar (${JSON.stringify(v)}) — `
          + 'GHA composes job display names from matrix values');
      }
    }
  }
  // The ledger fields are still THERE in the manifest — stripped from the
  // matrix, not deleted from the source of truth.
  const cosmo = legsDirect('release').find((l) => l.leg === 'cosmo');
  assert.ok(cosmo.runTargets && cosmo.fidelity, 'the manifest must still carry the ledger fields');
});

// A `how` names the rig the run was driven on. If that id does not appear in
// PLATFORMS.md, the citation is unfollowable — the reader cannot find out what
// the box was, what it could run, or how to re-drive the row there. `ci` is the
// one literal allowed without a section id lookup, and PLATFORMS.md documents
// it as a rig too.
test('every fidelity `how` names a rig that exists in PLATFORMS.md', () => {
  const platforms = fs.readFileSync(path.join(REPO, 'test/fidelity/PLATFORMS.md'), 'utf8');
  const ids = new Set([...platforms.matchAll(/\*\*Rig id:\*\*\s*`([a-z0-9-]+)`/g)].map((m) => m[1]));
  assert.ok(ids.size >= 5, `PLATFORMS.md must label its rig sections with ids (found ${ids.size})`);
  for (const rt of publishedRunTargets()) {
    const f = fidelityFor(rt);
    if (!f.how) continue;
    assert.ok(f.how === 'ci' || ids.has(f.how),
      `${rt}: how='${f.how}' is not a rig id in test/fidelity/PLATFORMS.md `
      + `(known: ${[...ids].sort().join(', ')})`);
  }
});

// RESULTS.md quarantines a contaminated darwin-arm64 run under `## Attempted,
// not evidence`. Those rows are REAL recorded outcomes and are deliberately
// written down — but they are not evidence, and one of them (B4 fail, dated
// AFTER the B4 pass) would, if counted, revoke coverage the ledger legitimately
// holds. Section-blind parsing plus latest-wins is exactly how a disqualified
// run would come back to grade the ledger.
test('the parser reads the results table only — quarantined rows are not evidence', () => {
  const text = fs.readFileSync(path.join(REPO, 'test/fidelity/RESULTS.md'), 'utf8');
  const quarantineStart = text.indexOf('## Attempted, not evidence');
  assert.ok(quarantineStart > 0, 'the quarantine section must exist');
  const quarantine = text.slice(quarantineStart);
  assert.match(quarantine, /^\| 2\d{3}-\d{2}-\d{2} \| darwin-arm64 \| B4 \|.*\| fail \|/m,
    'this test needs a dated table row inside the quarantine section to be meaningful');

  const parsed = parseResultsRows(text);
  assert.ok(parsed.length > 0, 'the results table must parse');
  for (const r of parsed) {
    assert.ok(!(r.rt === 'darwin-arm64' && r.row === 'B4' && r.verdict === 'fail'),
      'a row from the quarantine section was parsed as evidence');
  }
  // ...and end to end: darwin-arm64 keeps B4 despite the later quarantined fail.
  assert.ok(floorCoverage('darwin-arm64').green.includes('B4'),
    'the quarantined B4 fail must not revoke the recorded B4 pass');

  // Synthetic proof of the two rules in isolation: a later fail revokes, and a
  // row after a `##` heading is invisible.
  const synthetic = [
    '| date | run-target | row | engine | bundle | verdict | note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 2026-01-01 | fake-target | B1 | quaude | 1.0.0 | pass | first |',
    '| 2026-02-01 | fake-target | B1 | quaude | 1.0.0 | fail | regressed |',
    '| 2026-01-01 | other-target | C1 | quaude | 1.0.0 | pass | kept |',
    '',
    '## Attempted, not evidence',
    '',
    '| 2026-03-01 | other-target | C1 | quaude | 1.0.0 | fail | contaminated |',
  ].join('\n');
  const rows = parseResultsRows(synthetic);
  assert.deepStrictEqual(rows.map((r) => `${r.rt}/${r.row}/${r.verdict}`),
    ['fake-target/B1/pass', 'fake-target/B1/fail', 'other-target/C1/pass'],
    'rows after the first ## heading must not be parsed');
});

// EVERY IN-GUEST LEG HAS TO HAVE A ZSTD, and has to have said WHY it has one.
//
// Claude Code 2.1.251+ embeds its text assets as zstd frames, so from that release the carve
// spawns a host `zstd` (libexec/bun-graph.cjs -> libexec/host-provision.cjs). A leg whose build
// runs INSIDE a guest VM carves in that guest, so the guest is what needs the tool — and this is
// not theory: on cf45a8c (run 33241941716) 19 legs passed and haiku-x64 failed at exactly that
// line, because Haiku's guest had no zstd CLI.
//
// The gate is deliberately an ACCOUNTING one rather than a golden list of names: a new BSD or
// illumos leg added next month gets the question asked at review time instead of at its first
// red build. Two honest answers per leg —
//   'base'    the OS ships a zstd CLI in its base system, EVIDENCED by a green in-guest carve
//   'package' the guest-packages list must name it (and must actually name the COMMAND: on
//             Haiku `zstd` is the library and `cmd:zstd` is the CLI)
// — and nothing else. An unlisted leg fails.
//
// EVIDENCE for every 'base' row: CI run 33241941716 on cf45a8c, the first push after the carve
// started needing zstd. Each of these legs completed its in-guest `clode build` there with no
// zstd in its package list, which is exactly the proof that its base system carries one. The
// three arm64 twins are release-only, so they were not in that run; they are the SAME cpa guest
// images and package lists as their green amd64 siblings, and they stay 'base' on that basis.
const ZSTD_SOURCE = {
  'netbsd-amd64': 'base', 'netbsd-arm64': 'base',
  'freebsd-amd64': 'base', 'freebsd-arm64': 'base',
  'openbsd-amd64': 'base', 'openbsd-arm64': 'base',
  'dragonflybsd-amd64': 'base',
  'omnios-amd64': 'base',
  'solaris-amd64': 'base',
  'midnightbsd-amd64': 'base',
  'openindiana-amd64': 'base',
  'haiku-x64': 'package',
  // netbsd-sparc is the odd one out: its guest is our own baked wd0 image (CI-IMAGES.md)
  // and it has NO guest-packages at all, so whatever zstd it has comes from the image.
  // It is listed here rather than excluded because an exclusion is a silent cap — and it
  // is NOT known to be fine: the leg has failed at its in-guest `clode build` (smoke-exit=1)
  // on every run since at least 2026-08-28, and the cause cannot be read off CI because the
  // guest console log, which holds the actual error, is not uploaded on failure. See BACKLOG.
  'netbsd-sparc': 'image',
};
// DERIVED from .github/actions/build-leg/action.yml, not hand-copied. Its `mode` step decides
// where a leg builds with one shell `case`, and the exec=guest arm is the definitive list of
// platforms whose build+fuse+carve happen inside the VM. A mirror of it here would match today
// and drift silently the moment a platform is added — and the gate's whole claim is "an unlisted
// leg fails", which a stale mirror quietly converts into "an unlisted PLATFORM is skipped". In a
// repo whose rule is one source per fact, reading the source is cheaper than syncing a copy.
function inGuestPlatforms() {
  const yml = fs.readFileSync(path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8');
  const m = yml.match(/^\s*([a-z0-9|-]+)\)\s*exec=guest\s*;;/m);
  assert.ok(m, 'could not find the `exec=guest` case arm in build-leg/action.yml — if that step '
    + 'was restructured, this gate must be re-pointed at wherever it now decides in-guest builds');
  return new Set(m[1].split('|'));
}
// ...plus the qemu-* legs, which carve in-guest too, via their own backend and baked image.
const carvesInGuest = (gp, set) => !!gp && (set.has(gp) || gp.startsWith('qemu-'));

// The decoder names provision() will actually look for, read from the registry rather than
// restated — so adding a candidate there cannot leave this gate rejecting a legitimate package.
const ZSTD_CMDS = require('../libexec/host-provision.cjs').REGISTRY.zstd.candidates.map((c) => c.name);

test('every leg that carves inside a guest VM accounts for its zstd', () => {
  const inGuest = inGuestPlatforms();
  const seen = new Set();
  for (const l of legsFor('release').concat(legsFor('ci'))) {
    const gp = l['guest-platform'];
    if (!carvesInGuest(gp, inGuest)) continue;
    if (l['cross-image'] || l['cross-dockerfile'] || l['netbsd-src']) continue; // cross legs carve on the runner
    seen.add(l.leg);   // a leg in BOTH tiers is one leg, not two — the floor below must mean legs
    const how = ZSTD_SOURCE[l.leg];
    assert.ok(how, `${l.leg}: builds in a guest VM but ZSTD_SOURCE says nothing about its zstd. `
      + 'Carving 2.1.251+ needs one. Either prove the base system has it (a green in-guest carve) '
      + 'and add it as \'base\', name the command in guest-packages and add it as \'package\', '
      + 'or say it comes from a baked guest image and add it as \'image\'.');
    if (how === 'package') {
      const pkgs = String(l['guest-packages'] || '').split(/\s+/).filter(Boolean);
      // THE PACKAGE MUST NAME THE COMMAND, not the library — the exact regression
      // scripts/tjs-legs.mjs spends nine lines warning about on the haiku leg. Haiku's `zstd`
      // package is libzstd; the executables are in `zstd_bin`, reached by the `cmd:` provides
      // name. A bare `zstd` there installs the library, resolves green, and leaves the carve
      // exactly as broken — so on a provides-syntax guest the prefix is REQUIRED, not optional.
      const provides = gp === 'haiku';
      const accepted = ZSTD_CMDS.flatMap((c) => (provides ? [`cmd:${c}`] : [c, `cmd:${c}`]));
      assert.ok(pkgs.some((pkg) => accepted.includes(pkg)),
        `${l.leg}: ZSTD_SOURCE says 'package' but guest-packages (${l['guest-packages']}) names `
        + `no zstd COMMAND. Expected one of ${accepted.join(', ')}`
        + (provides ? ' — a bare `zstd` on Haiku is the LIBRARY, not the CLI.' : '.'));
    }
  }
  // Every leg named in the table must actually still exist, or the table is documenting ghosts.
  for (const leg of Object.keys(ZSTD_SOURCE)) {
    assert.ok(seen.has(leg), `ZSTD_SOURCE names ${leg}, which is no longer an in-guest leg`);
  }
});

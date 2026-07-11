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
  const gp = l['guest-platform'];
  if (gp && gp !== 'native') return gp === 'alpine' ? 'linux' : gp;
  return l.os.startsWith('macos') ? 'darwin' : 'linux';
};

test('release tier: every published leg is present (golden)', () => {
  const release = legsFor('release');
  const published = release.filter((l) => l.publish).map((l) => l.leg).sort();
  assert.deepStrictEqual(published, [
    'darwin-arm64', 'darwin-x64',
    'dragonflybsd-amd64',
    'freebsd-amd64', 'freebsd-arm64',
    'haiku-x64',
    'linux-arm64-musl', 'linux-armv7-musl', 'linux-loongarch64-musl',
    'linux-ppc64le-musl', 'linux-riscv64-musl', 'linux-s390x-musl',
    'linux-x64-musl', 'linux-x86-musl',
    'midnightbsd-amd64',
    'netbsd-amd64', 'netbsd-arm64',
    'omnios-amd64', 'openbsd-amd64', 'openbsd-arm64',
    'openindiana-amd64',
    'solaris-amd64',
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
      assert.ok(!l['guest-platform'] && l.os.startsWith('macos'),
        `${l.leg}: macos-* floor fields belong only on native darwin legs`);
    }
  }
  for (const l of ci) {
    assert.ok(!('macos-min' in l) && !('macos-sdk' in l)
      && !('macos-arch' in l) && !('no-exec' in l),
      `${l.leg}: ci tier must strip the macos-* floor fields and no-exec`);
  }
});

test('darwin-x86 Tiger leg: engine-only i386 at floor 10.4', () => {
  const release = legsFor('release');
  const dt = release.find((l) => l.leg === 'darwin-x86');
  assert.strictEqual(dt['macos-min'], '10.4');
  assert.strictEqual(dt['macos-sdk'], '10.4u');
  assert.strictEqual(dt['macos-arch'], 'i386');
  assert.strictEqual(dt['no-exec'], true);
  assert.strictEqual(dt.publish, false);
  // No GitHub runner can exec the output of a no-exec leg — fusing and
  // publishing a builder is impossible there by definition.
  for (const l of release) {
    if (l['no-exec']) assert.ok(!l.publish, `${l.leg}: no-exec legs must not publish`);
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

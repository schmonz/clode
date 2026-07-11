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
  const CONFIG = ['os', 'guest-platform', 'guest-arch', 'guest-version', 'guest-packages',
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

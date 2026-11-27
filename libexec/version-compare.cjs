'use strict';
// version-compare — THE one way clode, quaude and naude order two version strings. There were nine hand-written
// comparators (docs/superpowers/findings/2026-11-27-latent-capabilities-audit.md, D6, listed five), and they
// disagreed on short inputs: rg-native counted a missing part as 0, scripts/lib/native-intl's NaN made '18.0' greater
// than '18.0.0', clode-signals compared three parts and ignored a fourth, the target updater's fallback compared
// strings ('2.1.9' > '2.1.10'), and clode-watch borrowed npm semver from the dep store, so with no deps installed it
// answered "not newer" for every upstream release and the watcher never alarmed.
//
// compareVersions(a, b) -> -1 | 0 | 1, for RELEASE versions, the shape every caller but one compares:
//   upstream Claude Code (2.1.332), ugrep (5.0.0), Unicode/ICU (17.0, 17.0.0), cmake (3.23), macOS floors (10.4,
//   10.14), clode's date versions (0.20261125.1).
//   - a leading 'v' is allowed (node's process.version).
//   - the release is any number of dot-separated decimal parts, compared numerically; a MISSING part is 0, so
//     '18.0' equals '18.0.0' and '10.14' is past '10.4'.
//   - a '-' suffix is a prerelease, ordered as semver 2.0.0 section 11 orders it: it sorts BEFORE its release
//     ('2.0.0-rc1' < '2.0.0'); identifiers compare left to right, numeric ones numerically and below alphanumeric
//     ones, alphanumeric ones in ASCII order, and a shorter run of equal identifiers first.
//   - '+build' metadata is ignored, as semver ignores it.
//   - anything else is not a version: a TypeError, never a guess. A caller that must not throw catches it.
// This is NOT Bun.semver (bun-shim backs that with npm semver, ranges and all, because the bundle asks for npm's
// exact answers); it agrees with semver.compare on every full x.y.z input.
//
// compareLabels(a, b): the one caller whose inputs are not release versions, scripts/check-guest-versions.mjs, orders
// CI guest-image catalog labels: 10.1, 7.10, 6.4.2, r151058, r1beta5, 202604-build, 11.4-gcc. Those are split into
// runs of digits and non-digits at '.' and '-', digit runs compared numerically, other runs in ASCII order, a missing
// run lowest. Its '-' is part of the name ('11.4-gcc' is a later image than '11.4'), the opposite of a prerelease,
// which is why it is a second, named rule and not a mode of the first.
//
// Require-free: it travels as rg-native.cjs's companion (bun-shim's, transitively) in every packaging, and the
// clode builder bundles it. test/version-compare.test.cjs holds both rules to every caller's real inputs.

const RELEASE_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(s) {
  const m = RELEASE_RE.exec(String(s));
  if (!m) return null;
  return { release: m[1].split('.').map(Number), pre: m[2] ? m[2].split('.') : [] };
}

const sign = (d) => (d < 0 ? -1 : d > 0 ? 1 : 0);

function comparePre(x, y) {
  if (!x.length || !y.length) return sign(y.length - x.length);   // no prerelease sorts after any prerelease
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    const a = x[i], b = y[i];
    if (a === b) continue;
    const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
    if (na && nb) return sign(Number(a) - Number(b));
    if (na !== nb) return na ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new TypeError(`not a version: ${JSON.stringify(String(x ? b : a))}`);
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const d = (x.release[i] || 0) - (y.release[i] || 0);
    if (d) return sign(d);
  }
  return comparePre(x.pre, y.pre);
}

function compareLabels(a, b) {
  const runs = (s) => String(s).split(/[.-]/).flatMap((p) => p.match(/\d+|\D+/g) || []);
  const A = runs(a), B = runs(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = i < A.length ? A[i] : '', y = i < B.length ? B[i] : '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return sign(Number(x) - Number(y));
    return x < y ? -1 : 1;
  }
  return 0;
}

module.exports = { parseVersion, compareVersions, compareLabels };

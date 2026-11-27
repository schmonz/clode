'use strict';
// libexec/version-compare.cjs, the one version order: a table of every caller's real inputs, the old comparators'
// answers where they were right, and the guard that keeps a hand-written comparator from coming back.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseVersion, compareVersions, compareLabels } = require('../libexec/version-compare.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('./source-scan.cjs');

const REPO = path.resolve(__dirname, '..');

// [a, b, expected sign, whose input this is]
const RELEASE_ROWS = [
  // upstream Claude Code: clode-signals' changelog range, clode-watch's newer check, the target updater's fallback,
  // test/provider-resolve's pin compare
  ['2.1.332', '2.1.330', 1, 'claude'], ['2.1.330', '2.1.330', 0, 'claude'], ['2.1.9', '2.1.10', -1, 'claude: not a string compare'],
  ['2.1.251', '2.1.278', -1, 'claude'], ['3.0.0', '2.99.999', 1, 'claude'], ['2.0.0', '2.0.0-rc1', 1, 'claude: a prerelease precedes its release'],
  // ugrep: rg-native's floor
  ['3.11.2', '5.0.0', -1, 'ugrep'], ['4.99.99', '5.0.0', -1, 'ugrep'], ['5.0.0', '5.0.0', 0, 'ugrep'], ['5.0.1', '5.0.0', 1, 'ugrep'],
  ['7.8.2', '5.0.0', 1, 'ugrep'], ['10.0.0', '5.0.0', 1, 'ugrep'],
  // Unicode / ICU: scripts/lib/native-intl (process.versions.unicode is '17.0'; the tables key '17.0.0')
  ['17.0', '17.0.0', 0, 'unicode: a missing part is 0'], ['18.0', '17.0.0', 1, 'unicode'], ['16.0', '17.0', -1, 'unicode'],
  // cmake: build-tjs's CMAKE_IGNORE_PREFIX_PATH gate
  ['3.23.0', '3.23', 0, 'cmake'], ['3.22.6', '3.23', -1, 'cmake'], ['4.0.2', '3.23', 1, 'cmake'], ['2.8.12', '3.23', -1, 'cmake'],
  // macOS floors: scripts/macho-floor (LC_BUILD_VERSION from 10.14)
  ['10.14', '10.14', 0, 'macos'], ['10.4', '10.14', -1, 'macos: numeric, not lexical'], ['10.13', '10.14', -1, 'macos'],
  ['11.0', '10.14', 1, 'macos'], ['10.6', '10.14', -1, 'macos'],
  // clode's date versions
  ['0.20261125.1', '0.20260718.1', 1, 'clode'], ['0.20261125.2', '0.20261125.1', 1, 'clode'], ['0.20261125.1', '0.20261125.1', 0, 'clode'],
  // node versions, with node's 'v'
  ['v24.21.0', '24.9.0', 1, 'node'], ['v26.3.0', 'v26.3.0', 0, 'node'],
  // semver section 11's own example chain
  ['1.0.0-alpha', '1.0.0-alpha.1', -1, 'semver'], ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1, 'semver'],
  ['1.0.0-alpha.beta', '1.0.0-beta', -1, 'semver'], ['1.0.0-beta', '1.0.0-beta.2', -1, 'semver'],
  ['1.0.0-beta.2', '1.0.0-beta.11', -1, 'semver'], ['1.0.0-beta.11', '1.0.0-rc.1', -1, 'semver'], ['1.0.0-rc.1', '1.0.0', -1, 'semver'],
  ['1.0.0+build.5', '1.0.0', 0, 'semver: build metadata is ignored'],
];

test('compareVersions: every caller\'s real inputs, both ways round', () => {
  for (const [a, b, want, who] of RELEASE_ROWS) {
    assert.strictEqual(compareVersions(a, b), want, `${who}: ${a} vs ${b}`);
    assert.strictEqual(compareVersions(b, a), -want || 0, `${who}: ${b} vs ${a}`);
  }
});

test('compareVersions agrees with npm semver on every full x.y.z row, where semver is installed', (t) => {
  let semver;
  try { semver = require(path.join(REPO, 'deps', 'claude', 'node_modules', 'semver')); } catch { return t.skip('deps/claude/node_modules/semver not installed'); }
  const full = (v) => /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(v);
  let n = 0;
  for (const [a, b] of RELEASE_ROWS) if (full(a) && full(b)) { assert.strictEqual(compareVersions(a, b), semver.compare(a, b), `${a} vs ${b}`); n++; }
  assert.ok(n >= 25, `compared ${n}`);
});

test('compareVersions refuses what is not a version, naming it', () => {
  for (const bad of ['', 'garbage', '2..1', '2.1.x', 'latest', '1.0.0-', '1.0.0-a..b', ' 2.1.0']) {
    assert.throws(() => compareVersions(bad, '1.0.0'), (e) => e instanceof TypeError && e.message.includes(JSON.stringify(bad)), JSON.stringify(bad));
  }
  assert.strictEqual(parseVersion('nope'), null);
  assert.deepStrictEqual(parseVersion('v1.2.3-rc.1+b'), { release: [1, 2, 3], pre: ['rc', '1'] });
});

// scripts/check-guest-versions.mjs's catalog labels. A '-' there names a later image, never a prerelease.
test('compareLabels: the guest catalogs\' formats', () => {
  for (const [a, b, want] of [
    ['7.9', '7.10', -1], ['10.1', '9.4', 1], ['r151056', 'r151058', -1], ['202510-build', '202604-build', -1],
    ['6.4.2', '6.4.2', 0], ['r1beta5', 'r1beta5', 0], ['r1beta5', 'r1beta6', -1], ['14.4', '15.1', -1], ['11.4', '11.4-gcc', -1],
  ]) {
    assert.strictEqual(Math.sign(compareLabels(a, b)), want, `${a} vs ${b}`);
    assert.strictEqual(Math.sign(compareLabels(b, a)), -want || 0, `${b} vs ${a}`);
  }
});

// ==========================================================================
// GUARD: NO HAND-WRITTEN VERSION COMPARE IN SHIPPED OR BUILD CODE.
// ==========================================================================
//
// There were nine (latent-capabilities audit, D6, found five) and they disagreed on a missing part, a fourth part,
// a prerelease and, in the updater's fallback, on '2.1.9' vs '2.1.10'. A comparator has a recognisable body: a
// string split at '.' and its parts compared by index; or the two-field form `major > 3 || (major === 3 &&
// minor >= 23)`; or the packed form `major * 100 + minor >= 1014`. Each of those, in libexec or scripts, outside the
// one module, is a finding.
const SHAPES = [
  { re: /split\(\s*(['"])\.\1\s*\)[\s\S]{0,300}?\[\s*i\s*\][\s\S]{0,40}?(!==|===|<|>|\s-\s)/, what: "splits at '.' and compares the parts by index" },
  { re: /\b(\w+)\s*>\s*\d+\s*\|\|\s*\(\s*\1\s*===\s*\d+\s*&&\s*\w+\s*>=?\s*\d+/, what: 'compares major, then minor, by hand' },
  { re: /\*\s*100\s*\+\s*[\w.()[\]]+\s*>=?\s*\d{3,}/, what: 'packs major * 100 + minor and compares the number' },
];
const ONE_MODULE = 'libexec/version-compare.cjs';

function readSources() {
  const files = [path.join(REPO, 'libexec'), path.join(REPO, 'scripts')]
    .flatMap((d) => discoverFilesByExt(d, ['.cjs', '.js', '.mjs']));
  return { sources: files.map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join('/'), text: stripLineComments(fs.readFileSync(f, 'utf8')) })) };
}

function scanHandWrittenVersionCompare({ sources }) {
  const findings = [];
  for (const s of sources) {
    if (s.rel === ONE_MODULE) continue;
    for (const k of SHAPES) if (k.re.test(s.text)) findings.push(`${s.rel}: ${k.what}, a version compare written by hand; ask ${ONE_MODULE}'s compareVersions (or compareLabels for catalog labels)`);
  }
  return { findings, examined: sources.length };
}

// Measured 2026-11-27: 186 .cjs/.js/.mjs files under libexec and scripts (node_modules excluded). The floor is far
// under that and far above a broken walk.
guardTests(defineGuard({
  name: 'no-hand-written-version-compare',
  floor: 150,
  read: readSources,
  scan: scanHandWrittenVersionCompare,
  // the defect as it was: rg-native.cjs's versionAtLeast
  control: () => ({ sources: [{ rel: 'libexec/rg-native.cjs', text: "function versionAtLeast(v, min) {\n  const a = String(v).split('.').map(Number), b = String(min).split('.').map(Number);\n  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);\n  return true;\n}" }] }),
}));

test('no-hand-written-version-compare: each old shape is recognised on its own', () => {
  for (const text of [
    "const verKey = (v) => v.split('.').map((x) => parseInt(x, 10));\nfunction cmpKey(a, b) {\n  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }\n  return 0;\n}",
    "function c(a, b) { const A = a.split('.').map(Number), B = b.split('.').map(Number);\n  for (let i = 0; i < Math.max(A.length, B.length); i++) {\n    const d = (A[i] || 0) - (B[i] || 0);",
    'function cmakeVersionSupportsIgnorePrefixPath(major, minor) {\n  return major > 3 || (major === 3 && minor >= 23);\n}',
    'return Number(m[1]) * 100 + Number(m[2]) >= 1014;',
  ]) {
    assert.strictEqual(scanHandWrittenVersionCompare({ sources: [{ rel: 'synthetic.cjs', text }] }).findings.length, 1, text);
  }
  // node-shim's no_proxy range packs IPv4 octets, which is not a version compare
  assert.deepStrictEqual(scanHandWrittenVersionCompare({ sources: [{ rel: 'synthetic.cjs', text: "const p = String(s).split('.').map(Number);\n  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];" }] }).findings, []);
});

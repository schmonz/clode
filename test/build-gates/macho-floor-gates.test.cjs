'use strict';
// scripts/macho-floor.cjs — the build-leg floor gate's verdict, driven by REAL `otool -l`
// captures (test/fixtures/macho-floor/, first line normalized to drop the capture path):
//   release-0.20260831.1-<arch>: the four slices of the published clode-0.20260831.1-macos
//     (arm64 carries LC_BUILD_VERSION minos 14.0 under its 11.0 floor label — the defect
//     a0a2d4e fixed; x86_64 10.6, i386 10.4, ppc 10.4 via LC_VERSION_MIN_MACOSX);
//   tjs-arm64-minos11: a tjs engine built here with CLODE_TJS_MACOS_MIN=11.0 (SDK 27.2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// The literal relative require below is what the build-gates population sweep reads to
// know this guard controls scripts/macho-floor.cjs.
const { floorFindings, parseOtoolLoadCommands, usesBuildVersion } = require('../../scripts/macho-floor.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const FIX = path.join(__dirname, '..', 'fixtures/macho-floor');
const otool = (name) => fs.readFileSync(path.join(FIX, `${name}.otool.txt`), 'utf8');

test('the shipped 0.20260831.1 arm64 slice (minos 14.0) FAILS an 11.0 floor', () => {
  const f = floorFindings(otool('release-0.20260831.1-arm64'), '11.0');
  assert.deepStrictEqual(f, ['LC_BUILD_VERSION minos 14.0, want 11.0']);
});

test('an engine built with deployment target 11.0 passes an 11.0 floor', () => {
  assert.deepStrictEqual(floorFindings(otool('tjs-arm64-minos11'), '11.0'), []);
});

for (const [arch, floor] of [['ppc', '10.4'], ['i386', '10.4'], ['x86_64', '10.6']]) {
  test(`LC_VERSION_MIN_MACOSX ${floor} (${arch} slice) passes its old floor, and no other`, () => {
    assert.deepStrictEqual(floorFindings(otool(`release-0.20260831.1-${arch}`), floor), []);
    assert.notDeepStrictEqual(floorFindings(otool(`release-0.20260831.1-${arch}`), floor === '10.4' ? '10.6' : '10.4'), []);
  });
}

test('LC_BUILD_VERSION on an old-floor leg fails (pre-10.14 dyld cannot read it)', () => {
  const f = floorFindings(otool('tjs-arm64-minos11'), '10.6');
  assert.ok(f.some((x) => /LC_BUILD_VERSION present/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /no LC_VERSION_MIN_MACOSX/.test(x)), f.join('\n'));
});

test('an old-style binary on a new floor fails (no LC_BUILD_VERSION)', () => {
  assert.ok(floorFindings(otool('release-0.20260831.1-x86_64'), '11.0').some((x) => /no LC_BUILD_VERSION/.test(x)));
});

test('missing load commands fail', () => {
  assert.deepStrictEqual(floorFindings('', '11.0'), ['no load commands in the otool -l output (not a Mach-O, or otool failed)']);
  assert.deepStrictEqual(floorFindings('foo: is not an object file\n', '10.4').length, 1);
});

test('the parser reads the real captures', () => {
  assert.deepStrictEqual(parseOtoolLoadCommands(otool('release-0.20260831.1-arm64')).buildVersion, ['14.0']);
  assert.deepStrictEqual(parseOtoolLoadCommands(otool('release-0.20260831.1-ppc')).versionMin, ['10.4']);
  assert.ok(usesBuildVersion('10.14') && usesBuildVersion('11.0') && !usesBuildVersion('10.13') && !usesBuildVersion('10.4'));
});

test('the CLI exits 1 naming the reason, 0 on a match', () => {
  const cli = path.join(__dirname, '..', '..', 'scripts/macho-floor.cjs');
  const bad = spawnSync(process.execPath, [cli, 'check', '11.0', path.join(FIX, 'release-0.20260831.1-arm64.otool.txt')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /minos 14\.0, want 11\.0/);
  const ok = spawnSync(process.execPath, [cli, 'check', '11.0', path.join(FIX, 'tjs-arm64-minos11.otool.txt')], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /minos 11\.0/);
});

// The action must CALL the tested verdict, not re-grow an inline copy of it.
const floorGateGuard = defineGuard({
  name: 'macos-floor-gate-uses-macho-floor',
  read: () => ({ yml: fs.readFileSync(path.join(__dirname, '..', '..', '.github/actions/build-leg/action.yml'), 'utf8') }),
  scan: ({ yml }) => {
    const i = yml.indexOf('    - name: Floor gate — shipped asset carries the pinned floor');
    const body = i < 0 ? '' : yml.slice(i, yml.indexOf('\n    - name:', i + 1));
    const findings = [];
    if (!/node scripts\/macho-floor\.cjs check "\$\{\{ inputs\.macos-min \}\}"/.test(body)) findings.push('the macOS floor gate does not call scripts/macho-floor.cjs');
    if (/awk '\/cmd LC_(BUILD_VERSION|VERSION_MIN_MACOSX)/.test(body)) findings.push('the macOS floor gate re-grew an inline (untested) load-command parse');
    return { findings, examined: body ? 2 : 0 };
  },
  floor: 2,
  control: () => ({ yml: "    - name: Floor gate — shipped asset carries the pinned floor (x)\n        got=$(awk '/cmd LC_VERSION_MIN_MACOSX/{f=1} f && /version /{print $2; exit}' x)\n    - name: next\n" }),
});
guardTests(floorGateGuard);

// THE VERDICT AS A GUARD: every real capture whose floor is honest passes, and the
// control — the arm64 slice actually shipped in clode-0.20260831.1-macos, minos 14.0
// under an 11.0 label — must be refused. If floorFindings ever stops seeing minos, the
// control goes CANNOT_FAIL here before a real release ships the next mislabelled slice.
const verdictGuard = defineGuard({
  name: 'macho-floor-verdict',
  read: () => ({ rows: [
    ['tjs-arm64-minos11', '11.0'],
    ['release-0.20260831.1-x86_64', '10.6'],
    ['release-0.20260831.1-i386', '10.4'],
    ['release-0.20260831.1-ppc', '10.4'],
  ].map(([name, floor]) => ({ name, floor, text: otool(name) })) }),
  scan: ({ rows }) => ({
    findings: rows.flatMap((r) => floorFindings(r.text, r.floor).map((f) => `${r.name} @ ${r.floor}: ${f}`)),
    examined: rows.length,
  }),
  floor: 4,
  control: () => ({ rows: [{ name: 'release-0.20260831.1-arm64', floor: '11.0', text: otool('release-0.20260831.1-arm64') }] }),
});
guardTests(verdictGuard);

// Self-contained regression tests for libexec/clode-signals.cjs.
// No Python: runs ONLY the JS tool on fixed inputs and asserts its output
// against expected literals captured from the verified JS implementation.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.env.CLODE_NODE || process.execPath;
const REPO = path.resolve(__dirname, '..');
const JS_TOOL = path.join(REPO, 'libexec', 'clode-signals.cjs');

const CHANGELOG = [
  '# Changelog', '',
  '## 2.1.200', '',
  '- Upgraded the bundled Bun runtime to 1.3',
  '- requires the native binary for gateway',
  // NEGATIVE case: a non-HIGH, non-ASCII line that must NOT appear in the digest.
  '- A normal feature with an apostrophe ’ here', '',
  '## 2.1.195', '', '- old note', '',
].join('\n');

function run(args) {
  return spawnSync(NODE, [JS_TOOL, ...args], { encoding: 'utf8' });
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const EXPECT = {
  case1_digest:
    'clode signals for 2.1.200  (release notes 2.1.195..2.1.200):\n' +
    '  release notes (HIGH — bears on running under Node):\n' +
    '    ⚠ 2.1.200: Upgraded the bundled Bun runtime to 1.3\n' +
    '    ⚠ 2.1.200: requires the native binary for gateway\n',
  case1_json:
    '{\n  "bundle_phrases": {},\n  "changelog_flags": [\n    {\n' +
    '      "line": "Upgraded the bundled Bun runtime to 1.3",\n' +
    '      "tier": "high",\n      "version": "2.1.200"\n    },\n    {\n' +
    '      "line": "requires the native binary for gateway",\n' +
    '      "tier": "high",\n      "version": "2.1.200"\n    }\n  ],\n' +
    '  "version": "2.1.200"\n}\n',
  case2_digest:
    'clode signals for 2.1.200:\n  no new native-binary / runtime / npm signals.\n',
  case2_json:
    '{\n  "bundle_phrases": {},\n  "changelog_flags": [],\n  "version": "2.1.200"\n}\n',
  case3_delta:
    'clode signals for 2.1.200  (release notes 2.1.195..2.1.200):\n' +
    '  release notes (HIGH — bears on running under Node):\n' +
    '    ⚠ 2.1.200: Upgraded the bundled Bun runtime to 1.3\n' +
    '    ⚠ 2.1.200: requires the native binary for gateway\n' +
    '  bundle markers changed vs 2.1.195:\n' +
    '    requires the native binary (x1 → x2) ⚠\n',
  case4_digest:
    'clode signals for 2.1.200  (release notes 2.1.195..2.1.200):\n' +
    '  release notes (HIGH — bears on running under Node):\n' +
    '    ⚠ 2.1.200: Upgraded the bundled Bun runtime to 1.3\n' +
    '    ⚠ 2.1.200: requires the native binary for gateway\n' +
    '  bundle markers changed vs 2.1.195:\n' +
    '    requires the native binary (new, x2) ⚠\n' +
    '    install.sh instead of npm (new, x1) ⚠\n' +
    '    typeof Bun (new, x1)\n',
  case4_json:
    '{\n  "bundle_phrases": {\n    "install.sh instead of npm": 1,\n' +
    '    "not supported under npm": 0,\n    "requires the native binary": 2,\n' +
    '    "typeof Bun": 1\n  },\n  "changelog_flags": [\n    {\n' +
    '      "line": "Upgraded the bundled Bun runtime to 1.3",\n' +
    '      "tier": "high",\n      "version": "2.1.200"\n    },\n    {\n' +
    '      "line": "requires the native binary for gateway",\n' +
    '      "tier": "high",\n      "version": "2.1.200"\n    }\n  ],\n' +
    '  "version": "2.1.200"\n}\n',
};

test('clode-signals: changelog digest, --json, snapshot bytes', () => {
  withTmp((tmp) => {
    const cl = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(cl, CHANGELOG);
    const args = ['--version', '2.1.200', '--prev', '2.1.195', '--changelog-file', cl];

    const dig = run(args);
    assert.strictEqual(dig.status, 0, 'digest exit');
    assert.strictEqual(dig.stdout, EXPECT.case1_digest, 'digest stdout');

    const js = run([...args, '--json']);
    assert.strictEqual(js.status, 0, '--json exit');
    assert.strictEqual(js.stdout, EXPECT.case1_json, '--json stdout');

    const d = path.join(tmp, 'snap');
    run([...args, '--snapshot-dir', d]);
    const snap = fs.readFileSync(path.join(d, '2.1.200.json'), 'utf8');
    // The snapshot is the JSON document verbatim.
    assert.strictEqual(snap, EXPECT.case1_json, 'snapshot bytes');
  });
});

test('clode-signals: --version only (no prev, no changelog)', () => {
  withTmp((tmp) => {
    const args = ['--version', '2.1.200'];

    const dig = run(args);
    assert.strictEqual(dig.status, 0, 'digest exit');
    assert.strictEqual(dig.stdout, EXPECT.case2_digest, 'digest stdout');

    const js = run([...args, '--json']);
    assert.strictEqual(js.status, 0, '--json exit');
    assert.strictEqual(js.stdout, EXPECT.case2_json, '--json stdout');

    const d = path.join(tmp, 'snap');
    run([...args, '--snapshot-dir', d]);
    const snap = fs.readFileSync(path.join(d, '2.1.200.json'), 'utf8');
    assert.strictEqual(snap, EXPECT.case2_json, 'snapshot bytes');
  });
});

test('clode-signals: prev-snapshot delta path (⚠ markers + → render block)', () => {
  withTmp((tmp) => {
    const cl = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(cl, CHANGELOG);
    const D = path.join(tmp, 'snap');
    const oneP = path.join(tmp, 'b1.bin');
    const twoP = path.join(tmp, 'b2.bin');
    fs.writeFileSync(oneP, 'x requires the native binary x');
    fs.writeFileSync(twoP, 'requires the native binary ... requires the native binary');
    // Seed prev (2.1.195) snapshot with bundle count 1.
    run(['--version', '2.1.195', '--bundle', oneP, '--snapshot-dir', D]);
    // Delta run: count 1 -> 2 triggers the markers-changed render block.
    const args = ['--version', '2.1.200', '--prev', '2.1.195',
      '--changelog-file', cl, '--bundle', twoP, '--snapshot-dir', D];
    const r = run(args);
    assert.strictEqual(r.status, 0, 'delta exit');
    assert.strictEqual(r.stdout, EXPECT.case3_delta, 'delta-path stdout');
    // Guard against a vacuous test: confirm the delta block actually rendered.
    assert.ok(r.stdout.includes('→') && r.stdout.includes('bundle markers changed'),
      'delta block present in output');
  });
});

test('clode-signals: --bundle phrase counts (digest, --json, snapshot)', () => {
  withTmp((tmp) => {
    const cl = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(cl, CHANGELOG);
    const bundle = path.join(tmp, 'bundle.bin');
    fs.writeFileSync(bundle, [
      'some preamble',
      'requires the native binary here',
      'and again requires the native binary',
      'typeof Bun === "undefined"',
      'install.sh instead of npm path',
    ].join('\n'));
    const args = ['--version', '2.1.200', '--prev', '2.1.195',
      '--changelog-file', cl, '--bundle', bundle];

    const dig = run(args);
    assert.strictEqual(dig.status, 0, 'digest exit');
    assert.strictEqual(dig.stdout, EXPECT.case4_digest, 'digest stdout');

    const js = run([...args, '--json']);
    assert.strictEqual(js.status, 0, '--json exit');
    assert.strictEqual(js.stdout, EXPECT.case4_json, '--json stdout');

    const d = path.join(tmp, 'snap');
    run([...args, '--snapshot-dir', d]);
    const snap = fs.readFileSync(path.join(d, '2.1.200.json'), 'utf8');
    assert.strictEqual(snap, EXPECT.case4_json, 'snapshot bytes');
  });
});

// ---------------------------------------------------------------------------------
// CARVE INVARIANCE. signals/<version>.json is keyed by VERSION ALONE, but it is derived
// by scanning a PROVIDER BINARY -- and Bun constant-folds process.platform/arch at carve
// time, so two carves of one version are different bytes. That is the same missing
// dimension that let a linux-carved provider sit at this box's pinned path and produce a
// quaude reporting `Platform: linux-x64` on a Mac (BACKLOG.md, 2026-09-04).
//
// Measured 2026-09-04 on both carves of 2.1.251: the counts are IDENTICAL. The folded
// values are platform COMPARISONS; the tracked phrases are install-method and runtime
// messaging, which upstream does not vary by OS, and the changelog half is
// platform-independent by definition. So signals do NOT need the platform key the
// provider store needs -- today.
//
// This test is the guard on that "today". If a tracked phrase ever becomes
// platform-conditional, the version-only key starts silently recording whichever carve
// was scanned first, exactly like the provider store does -- and this goes red instead.
// Skips unless two carves of ONE version are actually available, and says so.
function twoCarvesOfOneVersion() {
  let providerPlatformOf;
  try { ({ providerPlatformOf } = require('../libexec/extract-claude-js.cjs')); } catch { return null; }
  const roots = [
    path.join(os.homedir(), '.local', 'share', 'clode', 'providers'),
    process.env.CLODE_SIGNALS_ALT_CARVE_DIR,
  ].filter(Boolean);
  const byVersion = new Map();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const bin = e.isDirectory() ? path.join(root, e.name, 'claude') : path.join(root, e.name);
      if (!fs.existsSync(bin) || fs.statSync(bin).isDirectory()) continue;
      const m = /(\d+\.\d+\.\d+)/.exec(e.name);
      if (!m) continue;
      let plat; try { plat = providerPlatformOf(bin); } catch { continue; }
      if (!plat || plat === 'unknown') continue;
      const seen = byVersion.get(m[1]) || new Map();
      if (!seen.has(plat)) seen.set(plat, bin);
      byVersion.set(m[1], seen);
    }
  }
  for (const [version, carves] of byVersion) {
    if (carves.size >= 2) return { version, carves: [...carves.entries()] };
  }
  return null;
}

test('clode-signals: the same version scans identically whatever carve it came from', (t) => {
  const found = twoCarvesOfOneVersion();
  if (!found) {
    t.skip('need two carves of ONE version to compare (point CLODE_SIGNALS_ALT_CARVE_DIR '
      + 'at a dir holding a foreign-carved provider, e.g. ~/.cache/clode/attic/...)');
    return;
  }
  const scans = found.carves.map(([plat, bin]) => {
    const r = spawnSync(process.execPath, [JS_TOOL, '--version', found.version, '--bundle', bin, '--json'],
      { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `scan of the ${plat} carve failed: ${r.stderr}`);
    return [plat, JSON.parse(r.stdout)];
  });
  const [[firstPlat, first], ...rest] = scans;
  for (const [plat, snap] of rest) {
    assert.deepStrictEqual(snap, first,
      `signals for ${found.version} differ between the ${firstPlat} and ${plat} carves. `
      + 'signals/<version>.json is keyed by version ALONE, so it now silently records '
      + 'whichever carve was scanned first — the provider store\'s defect, one layer over. '
      + 'Key the snapshot by platform too (see the umbrella, phase 4).');
  }
});

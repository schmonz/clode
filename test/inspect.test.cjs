// Unit + e2e tests for libexec/inspect-claude-bundle.cjs — node --test port of
// test/test_inspect.py (the Python oracle's unit suite).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'libexec', 'inspect-claude-bundle.cjs');
const SHIM = path.join(ROOT, 'libexec', 'bun-shim.cjs');
const BIN = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.183');
const NODE = process.env.CLODE_NODE || process.execPath;

const ins = require(SCRIPT);

test('count tallies regex groups', () => {
  const data = 'Bun.spawn(); Bun.spawn(); Bun.which()';
  assert.deepStrictEqual(ins.count(new RegExp(ins.BUN_API.source, 'g'), data), { spawn: 2, which: 1 });
});

test('feature_for_asset maps native addon to feature', () => {
  assert.ok(ins.featureForAsset('sharp.node').toLowerCase().includes('image'));
  assert.strictEqual(ins.featureForAsset('totally-unknown.node'), null);
});

test('coverage classifies implemented/stubbed/missing', () => {
  const r = {
    bun_api_real: { spawn: 1, serve: 1, Glob: 1 },
    bun_api_unrecognized: {}, bun_modules: {}, disabled_native_features: [],
  };
  const shim = { keys: ['spawn', 'serve'], stubs: ['serve'], modules: {} };
  const cov = ins.coverage(r, shim);
  assert.deepStrictEqual(cov.implemented, ['spawn']);
  assert.deepStrictEqual(cov.stubbed, ['serve']);
  assert.deepStrictEqual(cov.missing, ['Glob']);
});

test('yaml stub is accepted by strict gate', () => {
  const cov = { stubbed: ['YAML'], missing: [], bun_modules_unhandled: [], modules_missing: [] };
  assert.ok(!ins.gateProblems(cov).includes('Bun.YAML (stubbed)'));
});

test('detects known search applets', () => {
  const blob = 'OYr("find","bfs",["-S","dfs","-regextype","findutils-default"]),'
    + 'OYr("grep","ugrep",["-G","--ignore-files"])';
  assert.deepStrictEqual([...ins.searchApplets(blob)].sort(), ['bfs', 'ugrep']);
});

test('flags an unknown applet', () => {
  const blob = 'OYr("grep","ugrep",["-G"]),OYr("sk","skim",["--tac"])';
  assert.deepStrictEqual(ins.unknownSearchApplets(ins.searchApplets(blob)), ['skim']);
});

test('no unknown applets for the known set', () => {
  const blob = 'OYr("find","bfs",["-S"]),OYr("grep","ugrep",["-G"])';
  assert.deepStrictEqual(ins.unknownSearchApplets(ins.searchApplets(blob)), []);
});

test('ignores non-shadow calls', () => {
  const blob = 'argv0:"apply-seccomp";Qyd("apply-seccomp");Zz("arch","apply-seccomp",["amd64"])';
  assert.deepStrictEqual([...ins.searchApplets(blob)], []);
});

test('ripgrep lever tracked', () => {
  assert.strictEqual(ins.ripgrepLeverPresent('x USE_BUILTIN_RIPGREP y'), true);
  assert.strictEqual(ins.ripgrepLeverPresent('no lever here'), false);
});

test('embedded_applet_versions extracts ugrep and misses unstamped', () => {
  const blob = '...ugrep 7.5.0 built with...';
  assert.deepStrictEqual(ins.embeddedAppletVersions(blob), { ugrep: '7.5.0', bfs: null, rg: null });
});

test('embedded_applet_versions picks up bfs and rg if stamped', () => {
  const blob = 'bfs 4.0.6 / ripgrep 14.1.0 / ugrep 7.5.0';
  assert.deepStrictEqual(ins.embeddedAppletVersions(blob), { ugrep: '7.5.0', bfs: '4.0.6', rg: '14.1.0' });
});

test('host_applet_version parses from a stub via env override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-inspect-'));
  const stub = path.join(dir, 'bfs');
  fs.writeFileSync(stub, "#!/bin/sh\necho 'bfs 1.5.1'\n");
  fs.chmodSync(stub, 0o755);
  assert.strictEqual(ins.hostAppletVersion('bfs', { CLODE_BFS: stub }), '1.5.1');
});

test('host_applet_version none when absent', () => {
  assert.strictEqual(ins.hostAppletVersion('definitely-not-an-applet', {}), null);
});

test('human_applets flags host skew', () => {
  // Behavioral equivalent of the Python monkeypatch: a stub bfs reporting 1.5.1
  // via the CLODE_BFS host override, against an embedded 4.0.6.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-inspect-'));
  const stub = path.join(dir, 'bfs');
  fs.writeFileSync(stub, "#!/bin/sh\necho 'bfs 1.5.1'\n");
  fs.chmodSync(stub, 0o755);
  const r = { search_applets: ['bfs'], embedded_applet_versions: { bfs: '4.0.6' } };
  const out = ins.humanApplets(r, { CLODE_BFS: stub });
  assert.ok(out.includes('embedded 4.0.6') && out.includes('host 1.5.1'));
  assert.ok(out.includes('skew possible'));
});

test('ws is accepted external, not a coverage gap', () => {
  assert.ok(ins.ACCEPTED_MISSING_EXTERNALS.has('ws'));
  assert.deepStrictEqual(ins.unreviewedExternals(['ws']), []);
});

test('doctor hook anchor present', () => {
  const warn = 'return{installationType:_,version:A,multipleInstallations:f,'
    + 'warnings:L,packageManager:Y,ripgrepStatus:w}';
  assert.strictEqual(ins.doctorHookAnchorPresent('x ' + warn + ' y'), true);
  assert.strictEqual(ins.doctorHookAnchorPresent('nope'), false);
  assert.strictEqual(ins.doctorHookAnchorPresent(warn + warn), false);
});

test('doctor anchor absent when only a bare warnings key remains', () => {
  const body = 'something with warnings: in prose but no installationType return';
  assert.strictEqual(ins.doctorHookAnchorPresent(body), false);
});

test('autoupdater anchor present and absent', () => {
  const present = 'd("tengu_pkg_manager_auto_updater_start",e);'
    + 'let[_H,...AH]=a,qH=await o_(_H,AH,{cwd:x});';
  assert.strictEqual(ins.autoupdaterHookAnchorPresent(present), true);
  assert.strictEqual(ins.autoupdaterHookAnchorPresent('no autoupdater'), false);
});

test('native autoupdater anchor present and absent', () => {
  const present = 'd("tengu_native_auto_updater_start",{});'
    + 'try{let T=await _mH(w),Z={};';
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent(present), true);
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent('no native autoupdater'), false);
});

test('gate_problems flags missing native autoupdater anchor', () => {
  const cov = {
    stubbed: [], missing: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    native_autoupdater_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('native autoupdater')));
});

test('gate_problems flags missing doctor anchor', () => {
  const cov = {
    stubbed: [], missing: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true, doctor_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('/doctor')));
});

test('gate_problems includes unknown applet', () => {
  const cov = {
    stubbed: [], missing: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: ['skim'], ripgrep_lever_present: true,
  };
  assert.ok(ins.gateProblems(cov).includes('skim (search applet unhandled)'));
});

test('gate_problems flags missing ripgrep lever', () => {
  const cov = {
    stubbed: [], missing: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.toLowerCase().includes('ripgrep')));
});

test('gate_problems clean for known applets and present lever', () => {
  const cov = {
    stubbed: [], missing: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
  };
  assert.deepStrictEqual(ins.gateProblems(cov), []);
});

test('unreviewed_externals filters accepted', () => {
  assert.deepStrictEqual(ins.unreviewedExternals(['undici', 'esbuild']), ['undici']);
  assert.deepStrictEqual(ins.unreviewedExternals(['esbuild', 'react', 'typescript']), []);
});

test('gate_problems returns unreviewed items', () => {
  const covBad = {
    stubbed: ['serve', 'newfeature'],
    missing: [],
    bun_modules_unhandled: [],
    modules_missing: ['undici', 'esbuild'],
  };
  const problems = ins.gateProblems(covBad);
  assert.ok(problems.includes('Bun.newfeature (stubbed)'));
  assert.ok(problems.includes('undici (external require MISSING)'));
  assert.strictEqual(problems.length, 2);

  const covClean = {
    stubbed: [...ins.ACCEPTED_STUBBED_BUN],
    missing: [...ins.ACCEPTED_MISSING_BUN],
    bun_modules_unhandled: [...ins.ACCEPTED_BUN_MODULES],
    modules_missing: [...ins.ACCEPTED_MISSING_EXTERNALS],
  };
  assert.deepStrictEqual(ins.gateProblems(covClean), []);
});

// e2e: pick the highest pure-semver build/<ver>/cli.cjs; fall back to versioned install.
function newestBuildBundle() {
  const buildDir = path.join(ROOT, 'build');
  let best = null;
  let bestKey = [-1, -1, -1];
  let entries = [];
  try { entries = fs.readdirSync(buildDir); } catch (_) { return null; }
  for (const ver of entries) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver);
    if (!m) continue;
    const cli = path.join(buildDir, ver, 'cli.cjs');
    if (!fs.existsSync(cli)) continue;
    const key = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1]
      || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      best = cli; bestKey = key;
    }
  }
  return best;
}
const STRICT_BIN = newestBuildBundle() || BIN;

test('coverage report runs and is machine-readable',
  { skip: !(fs.existsSync(BIN) && fs.existsSync(SHIM)) }, () => {
    const r = spawnSync(NODE, [SCRIPT, BIN, '--shim', SHIM, '--node', NODE, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.ok('coverage' in doc && 'missing' in doc.coverage);
  });

test('strict gate clean on known-good bundle',
  { skip: !(fs.existsSync(STRICT_BIN) && fs.existsSync(SHIM)) }, () => {
    const rJson = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--shim', SHIM, '--node', NODE, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(rJson.status, 0, rJson.stderr);
    const cov = JSON.parse(rJson.stdout).coverage || {};
    assert.ok(!(cov.modules_missing || []).includes('undici'), 'undici still MISSING — host stub not active');
    assert.ok((cov.modules_host_stub || []).includes('undici'), 'undici not classified as host-stub');

    const rStrict = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--shim', SHIM, '--node', NODE, '--strict'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(rStrict.status, 0,
      `--strict exited ${rStrict.status}; unreviewed items:\n${rStrict.stderr}`);
  });

test('strict without shim is an error, not a silent pass',
  { skip: !fs.existsSync(STRICT_BIN) }, () => {
    const r = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--node', NODE, '--strict'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.notStrictEqual(r.status, 0, '--strict without --shim must not exit 0');
    assert.ok((r.stderr + r.stdout).toLowerCase().includes('shim'));
  });

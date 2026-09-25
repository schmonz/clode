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
// Resolved, never hardcoded. This read
//   path.join(os.homedir(), '.local/share/claude/versions/2.1.183')
// until 2026-09-02 — a version pinned into a test file, which is not on any current
// box and is not what UPSTREAM_PIN names. All three e2e tests below were therefore
// gated on an artifact nobody has, and (because they used `{ skip: <boolean> }`)
// they said nothing about it. They had not been skipping; they had been absent.
const { providerBin, skipReason } = require('./provider-resolve.cjs');
const BIN = providerBin();
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
  const cov = { stubbed: ['YAML'], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [] };
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
  // Mock the applet's `--version` output instead of spawning a real stub (cross-platform).
  const spawn = (exe, args) => {
    assert.deepStrictEqual(args, ['--version']);
    return { status: 0, stdout: 'bfs 1.5.1\n', stderr: '' };
  };
  assert.strictEqual(ins.hostAppletVersion('bfs', { CLODE_BFS: '/fake/bfs' }, spawn), '1.5.1');
});

test('host_applet_version none when absent', () => {
  assert.strictEqual(ins.hostAppletVersion('definitely-not-an-applet', {}), null);
});

test('human_applets flags host skew', () => {
  // Stub bfs reports 1.5.1 via a mock spawn, against an embedded 4.0.6.
  const spawn = () => ({ status: 0, stdout: 'bfs 1.5.1\n', stderr: '' });
  const r = { search_applets: ['bfs'], embedded_applet_versions: { bfs: '4.0.6' } };
  const out = ins.humanApplets(r, { CLODE_BFS: '/fake/bfs' }, spawn);
  assert.ok(out.includes('embedded 4.0.6') && out.includes('host 1.5.1'));
  assert.ok(out.includes('skew possible'));
});

test('ws is accepted external, not a coverage gap', () => {
  assert.ok(ins.ACCEPTED_MISSING_EXTERNALS.has('ws'));
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

test('doctor-load anchor retired: no export, no report field, snapshot gen kept', () => {
  // Upstream 2.1.205 removed /doctor's load site; the eager-snapshot bridge now
  // rides the installation-warnings splice, so the inspector tracks only
  // SNAPSHOT_GEN (+ the warnings anchor) for it.
  assert.ok(!('doctorLoadAnchorPresent' in ins));
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-doc-'));
  const p = path.join(tmp, 'body.js');
  fs.writeFileSync(p, 'async function A9(){let B9=await C9();return{provider:await D9(B9)}}');
  const r = ins.inspect(p);
  assert.ok(!('doctor_load_anchor_present' in r));
  assert.strictEqual(r.snapshot_generator_present, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// THE MIRROR IS PART OF THE ANCHOR, not a copy of it. inspect-claude-bundle.cjs's
// _SNAPSHOT_GEN_ANCHOR exists to answer "would patchSnapshotBridge apply?", which it can
// only answer if it is the SAME regex. It was already once a looser substring, and the
// gate reported the site present for three releases after the real anchor had stopped
// applying. Nothing pinned the two together, so the 2026-09-21 re-pin for 2.1.278's
// third generator shape could have landed in one file and not the other and read green
// here. Compared as SOURCE TEXT, read out of the two files, so neither literal has to be
// restated in this test.
test('the inspector\'s snapshot-generator anchor is byte-identical to the extractor\'s', () => {
  const literalAfter = (file, decl) => {
    const src = fs.readFileSync(path.join(ROOT, 'libexec', file), 'utf8');
    const i = src.indexOf(decl);
    assert.notStrictEqual(i, -1, `${file}: no \`${decl}\` declaration to compare`);
    const start = src.indexOf('/async function', i);
    const end = src.indexOf('/g;', start);
    assert.ok(start !== -1 && end > start, `${file}: could not read the anchor literal`);
    return src.slice(start, end + 2);
  };
  assert.strictEqual(
    literalAfter('inspect-claude-bundle.cjs', 'const _SNAPSHOT_GEN_ANCHOR ='),
    literalAfter('extract-claude-js.cjs', 'const SNAPSHOT_GEN ='),
    'the inspector mirror and the extractor anchor have drifted — one of them is now lying '
    + 'about whether the eager-snapshot bridge would apply');
});

// The five-day red light this re-pin closes: upstream-drift.yml reported
// `snapshot_generator_present = false` against `next` from 2026-09-17. Both ends are
// asserted, because an anchor that matches only the NEW shape trades one red for another:
// every build in CI stages the PIN.
for (const [version, gen] of [['2.1.251', 'CDn'], ['2.1.278', 'OCr']]) {
  test(`snapshotGeneratorPresent on the REAL ${version} bundle shape`, () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'doctor', `snapshot-gen-${version}.js`), 'latin1');
    assert.ok(src.includes(`async function ${gen}(`), `${version}: fixture lost its generator`);
    assert.strictEqual(ins.snapshotGeneratorPresent(src), true);
    assert.strictEqual(ins.snapshotGeneratorPresent(src + src), false,
      `${version}: a doubled bundle is ambiguous, not present`);
  });
}

test('autoupdater anchor present and absent', () => {
  const present = 'd("tengu_pkg_manager_auto_updater_start",e);'
    + 'let[_H,...AH]=a,qH=await o_(_H,AH,{cwd:x});';
  assert.strictEqual(ins.autoupdaterHookAnchorPresent(present), true);
  assert.strictEqual(ins.autoupdaterHookAnchorPresent('no autoupdater'), false);
});

test('native autoupdater anchor present and absent', () => {
  const present = 'd("tengu_native_auto_updater_start",{});'
    + 'try{let T=await _mH(w),Z={VERSION:"2.1.218"};';
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent(present), true);
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent('no native autoupdater'), false);
});

test('native autoupdater anchor: VERSION lookahead is left-bounded against an ENGINE_VERSION decoy', () => {
  // A decoy field (*_VERSION:) BEFORE the real standalone VERSION: field must not
  // fool the anchor into matching early with no real VERSION in view — same
  // left-boundary fix as extract-claude-js.cjs NATIVE_AUTOUPDATER. The anchor
  // itself doesn't capture the version (that's the extractor's job); it just
  // needs to still report "present" when a REAL standalone VERSION follows.
  const withDecoy = 'd("tengu_native_auto_updater_start",{});'
    + 'try{let T=await _mH(w),Z={ENGINE_VERSION:"9.9.9",VERSION:"2.1.230"};';
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent(withDecoy), true);

  // Decoy-only object (no standalone VERSION field at all) -> anchor absent, same
  // fail-loud posture the extractor's patch takes (applied:false, not a silent
  // wrong-version match on the ENGINE_VERSION suffix).
  const decoyOnly = 'd("tengu_native_auto_updater_start",{});'
    + 'try{let T=await _mH(w),Z={ENGINE_VERSION:"9.9.9"};';
  assert.strictEqual(ins.nativeAutoupdaterHookAnchorPresent(decoyOnly), false);
});

test('legacy autoupdater anchor present (raw + already-patched) and absent', () => {
  // Real 2.1.241 bytes (trimmed to the guard + the head of the install dispatch).
  const present = 'if(w(`AutoUpdater: Detected installation type: ${x}`),x==="development")'
    + '{w("AutoUpdater: Cannot auto-update development build"),t(!1);return}'
    + 'let I,M,L;if(x==="npm-local")w("AutoUpdater: Using local update method");';
  assert.strictEqual(ins.legacyAutoupdaterHookAnchorPresent(present), true);

  // PROVE THE CHECK IS NOT VACUOUS. A bundle with no legacy dispatch must report
  // false, and so must a body carrying the development guard alone — the whole
  // point of the lookahead is that the guard by itself is not the site we patch.
  assert.strictEqual(ins.legacyAutoupdaterHookAnchorPresent('no legacy autoupdater'), false);
  const guardOnly = 'if(w(`AutoUpdater: Detected installation type: ${x}`),x==="development")'
    + '{w("AutoUpdater: Cannot auto-update development build"),t(!1);return}let I,M,L;if(x==="other")q();';
  assert.strictEqual(ins.legacyAutoupdaterHookAnchorPresent(guardOnly), false);
  // ambiguous (two sites) is also not "present"
  assert.strictEqual(ins.legacyAutoupdaterHookAnchorPresent(present + present), false);

  // already-patched bundles still count as present: the splice breaks the base
  // anchor's lookahead, so only the injected marker can vouch for them.
  assert.strictEqual(ins.legacyAutoupdaterHookAnchorPresent(
    'w("AutoUpdater: install skipped: this binary is managed by clode (notify-only)"),t(!1);return;'),
  true);
});

test('gate_problems flags missing legacy autoupdater anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    legacy_autoupdater_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('LEGACY autoupdater')));
});

test('manual update anchor present (raw + already-patched) and absent', () => {
  // Real 2.1.241 bytes, trimmed to the two case arms the anchor pins.
  const present = 'switch(i.installationType){case"npm-local":h=!0,g="local";break;'
    + 'case"npm-global":h=!1,g="global";break;case"unknown":{let b=await Pqt();';
  assert.strictEqual(ins.manualUpdateHookAnchorPresent(present), true);

  // NOT VACUOUS: a bundle with no such switch, and one whose case arms assign
  // DIFFERENT locals than the switch's own pair, both report false.
  assert.strictEqual(ins.manualUpdateHookAnchorPresent('no update dispatch'), false);
  const mismatched = 'switch(i.installationType){case"npm-local":h=!0,g="local";break;'
    + 'case"npm-global":q=!1,z="global";break;case"unknown":{';
  assert.strictEqual(ins.manualUpdateHookAnchorPresent(mismatched), false);
  assert.strictEqual(ins.manualUpdateHookAnchorPresent(present + present), false);

  // already-patched bundles still count as present
  assert.strictEqual(ins.manualUpdateHookAnchorPresent(
    'switch("clode-managed-target"){case"npm-local":h=!0,g="local";break;'), true);
});

test('gate_problems flags missing manual update anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    manual_update_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('manual `update`')));
});

test('update notice anchor present (raw + already-patched) and absent', () => {
  const raw = 'return{installationType:t,version:r,installationPath:n,'
    + 'warnings:s,packageManager:f}';
  assert.strictEqual(ins.updateNoticeHookAnchorPresent(raw), true);
  // no version field -> not present (would be the skew-only anchor)
  assert.strictEqual(ins.updateNoticeHookAnchorPresent(
    'return{installationType:t,warnings:s,packageManager:f}'), false);
  assert.strictEqual(ins.updateNoticeHookAnchorPresent('no diagnostics here'), false);
  // already-patched bundles still count as present
  assert.strictEqual(ins.updateNoticeHookAnchorPresent(
    'var __clodeUpd=await globalThis.__clodeCheckUpdate(r);'), true);
});

test('gate_problems flags missing update notice anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    update_notice_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('update notice')));
});

test('remoteControlHookAnchorPresent: true on the real cBo reason, false when absent/ambiguous', () => {
  const one = 'if(!K8e())return"Remote Control is only available when using Claude via api.anthropic.com.";';
  assert.strictEqual(ins.remoteControlHookAnchorPresent(one), true);
  assert.strictEqual(ins.remoteControlHookAnchorPresent('nothing'), false);
  assert.strictEqual(ins.remoteControlHookAnchorPresent(one + one), false);
  // already-patched bundles still count as present
  assert.strictEqual(
    ins.remoteControlHookAnchorPresent('if(globalThis.__clodeWsUnavailable)return"x";' + one),
    true,
  );
});

test('remoteControlHookAnchorPresent: true on the 2.1.270 wrapped-reason gate', () => {
  // Upstream wraps every reason in a local `(e)=>({reason:e,orgPolicyDenied:!1})` helper at
  // 2.1.270, so the gate returns an object, never a bare string. The mirror here must move
  // with libexec/extract-claude-js.cjs or the two disagree about what "anchored" means.
  const wrapped = 'async function xen(){if(l())return null;if(!dG())return i(x());'
    + 'if(qC())return i("Remote Control is not available inside a cloud session.");return null}';
  assert.strictEqual(ins.remoteControlHookAnchorPresent(wrapped), true);
  assert.strictEqual(ins.remoteControlHookAnchorPresent(wrapped + wrapped), false);
  // and an already-patched 2.1.270 bundle, whose injection is object-shaped, still counts
  assert.strictEqual(
    ins.remoteControlHookAnchorPresent('if(globalThis.__clodeWsUnavailable)return{reason:"x",orgPolicyDenied:!1};' + wrapped),
    true,
  );
});

test('remoteControlHookAnchorPresent: true on the 2.1.281+ coded-reason gate', () => {
  // 2.1.281 gave the helper a code: `var i=(e,o)=>({reason:o,code:e,orgPolicyDenied:!1})`.
  // Verbatim from the real 2.1.282 bundle; the same fixture test/extract-hooks.test.cjs patches.
  const coded = fs.readFileSync(path.join(__dirname, 'fixtures', 'doctor', 'rc-gate-coded-2.1.282.js'), 'latin1');
  assert.strictEqual(ins.remoteControlHookAnchorPresent(coded), true);
  assert.strictEqual(ins.remoteControlHookAnchorPresent(coded + coded), false);
  assert.strictEqual(
    ins.remoteControlHookAnchorPresent('if(globalThis.__clodeWsUnavailable)return{reason:"x",code:"y",orgPolicyDenied:!1};' + coded),
    true,
  );
});

// ONE STATEMENT OF THE ANCHORS. This file used to restate every Remote Control regex from
// libexec/extract-claude-js.cjs ("keep them in step"), so a re-pin was two edits that had to
// agree. They are now read from the extractor, which is the only way the strict gate and the
// patch cannot disagree about what "anchored" means. The text check is the ratchet: a mirror
// that comes back names its own sentence here.
test('the Remote Control anchors have ONE statement: inspect reads the extractor\'s, never its own', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(text, /not available inside a cloud session/,
    'inspect-claude-bundle.cjs restates a Remote Control anchor instead of importing it');
  assert.doesNotMatch(text, /only available when using Claude via api/,
    'inspect-claude-bundle.cjs restates a Remote Control anchor instead of importing it');
  const ex = require(path.join(ROOT, 'libexec', 'extract-claude-js.cjs'));
  const fix = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'doctor', n), 'latin1');
  for (const src of [fix('cbo-remote-control-2.1.218.js'), fix('rc-gate-coded-2.1.282.js'), 'nothing']) {
    assert.strictEqual(ins.remoteControlHookAnchorPresent(src), ex.patchRemoteControlUnavailable(src)[1]);
  }
});

test('gate_problems flags missing native autoupdater anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    native_autoupdater_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('native autoupdater')));
});

test('gate_problems flags missing doctor anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true, doctor_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('/doctor')));
});

test('gate_problems flags missing remote control anchor', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
    remote_control_hook_anchor_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.includes('Remote Control')));
});

test('gate_problems includes unknown applet', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: ['skim'], ripgrep_lever_present: true,
  };
  assert.ok(ins.gateProblems(cov).includes('skim (search applet unhandled)'));
});

test('gate_problems flags missing ripgrep lever', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: false,
  };
  assert.ok(ins.gateProblems(cov).some((p) => p.toLowerCase().includes('ripgrep')));
});

test('gate_problems clean for known applets and present lever', () => {
  const cov = {
    stubbed: [], missing: [], unrecognized: [], bun_modules_unhandled: [], modules_missing: [],
    search_applets_unknown: [], ripgrep_lever_present: true,
  };
  assert.deepStrictEqual(ins.gateProblems(cov), []);
});

test('gate_problems returns unreviewed items', () => {
  const covBad = {
    stubbed: ['serve', 'newfeature'],
    missing: [],
    // A Bun member KNOWN_BUN has never heard of is the shape of upstream adopting a
    // new Bun API (2.1.278 did exactly this with Bun.sliceAnsi). It used to be
    // silently dropped here; it is a finding now.
    unrecognized: ['brandNewBunThing'],
    bun_modules_unhandled: [],
    modules_missing: ['undici', 'esbuild'],
  };
  const problems = ins.gateProblems(covBad);
  assert.ok(problems.includes('Bun.newfeature (stubbed)'));
  assert.ok(problems.some((p) => p.startsWith('Bun.brandNewBunThing (unrecognized')));
  assert.ok(problems.includes('undici (external require MISSING)'));
  assert.strictEqual(problems.length, 3);

  const covClean = {
    stubbed: [...ins.ACCEPTED_STUBBED_BUN],
    missing: [...ins.ACCEPTED_MISSING_BUN],
    unrecognized: [...ins.ACCEPTED_UNRECOGNIZED_BUN],
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

// node:test renders `{ skip: <boolean> }` as a bare "# SKIP" with no reason — a skip
// that cannot tell you what it wanted is indistinguishable from one that is hiding
// something, which is the pattern this repo keeps digging out. Returning a STRING
// makes the skip self-explaining; returning false runs the test.
function missingReason(required) {
  const absent = Object.entries(required).filter(([, p]) => !fs.existsSync(p));
  if (!absent.length) return false;
  return 'missing ' + absent.map(([what, p]) => `${what} at ${p}`).join('; ');
}


test('coverage report runs and is machine-readable',
  { skip: skipReason() || missingReason({ 'libexec/bun-shim.cjs (SHIM)': SHIM }) }, () => {
    const r = spawnSync(NODE, [SCRIPT, BIN, '--shim', SHIM, '--node', NODE, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.ok('coverage' in doc && 'missing' in doc.coverage);
  });

// DEFERRED, not silently: --strict currently exits 1 against any current bundle with
// 31 unreviewed upstream needs (30 Bun.* APIs + bun:sqlite). That is REAL drift, not a
// harness fault -- it went unseen because this file was pinned to provider 2.1.183,
// which no box has, so the whole test was absent rather than skipping. Each of the 31
// needs the same reachability judgement the zstd gap got: does our tested traffic
// actually reach it? Then a stub, or an entry in the ACCEPTED_* lists.
//
// Skipping with the reason spelled out, per the user's call (2026-09-02), rather than
// landing red -- and the umbrella now cannot close until this and every other skip is
// understood and un-skipped where possible. See BACKLOG.md.
const STRICT_DEFERRED = 'DEFERRED (BACKLOG.md, "31 unreviewed Bun APIs"): --strict exits 1 '
  + 'with 31 unreviewed upstream needs against current bundles. Reproduce: '
  + 'node libexec/inspect-claude-bundle.cjs "$(node -e \'console.log(require("./test/provider-resolve.cjs").providerBin())\')" '
  + '--shim libexec/bun-shim.cjs --node "$(command -v node)" --strict';

test('strict gate clean on known-good bundle',
  { skip: STRICT_DEFERRED }, () => {
    const rJson = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--shim', SHIM, '--node', NODE, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(rJson.status, 0, rJson.stderr);
    const cov = JSON.parse(rJson.stdout).coverage || {};
    // Assert the INVARIANT, not a module name. This used to hardcode `undici` --
    // true of the 2.1.183 bundle it was pinned to, false of 2.1.252, which does not
    // require undici at all. A test that names one module tracks that module's
    // fashion; what actually has to hold is: every module the shim DECLARES as a
    // host module must, if this bundle requires it, come back classified host-stub
    // and never `missing`. If the bundle needs none of them, there is nothing to
    // classify and that is not a failure.
    const declared = JSON.parse(
      fs.readFileSync(SHIM, 'utf8').match(/"hostModules"\s*:\s*(\[[^\]]*\])/)[1]);
    const stubbed = new Set(cov.modules_host_stub || []);
    const missing = new Set(cov.modules_missing || []);
    for (const m of declared) {
      assert.ok(!missing.has(m),
        `${m} is declared a hostModule in bun-shim.cjs but came back MISSING — the stub is not active`);
    }
    const required = declared.filter((m) => stubbed.has(m) || missing.has(m));
    for (const m of required) {
      assert.ok(stubbed.has(m), `${m} is required by this bundle but not classified host-stub`);
    }

    const rStrict = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--shim', SHIM, '--node', NODE, '--strict'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(rStrict.status, 0,
      `--strict exited ${rStrict.status}; unreviewed items:\n${rStrict.stderr}`);
  });

test('strict without shim is an error, not a silent pass',
  { skip: (STRICT_BIN ? false : skipReason()) }, () => {
    const r = spawnSync(NODE, [SCRIPT, STRICT_BIN, '--node', NODE, '--strict'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.notStrictEqual(r.status, 0, '--strict without --shim must not exit 0');
    assert.ok((r.stderr + r.stdout).toLowerCase().includes('shim'));
  });

'use strict';
// bundle-runs-own-home (grep-native Task 10b fix rounds 1-2, rulings G30 and G32): every test that SPAWNS THE BUNDLE
// (native Claude Code, a built quaude or naude, the staged cli.cjs under node or tjs) hands it a throwaway HOME, and a
// CLAUDE_CONFIG_DIR of its own whenever it passes process.env through, never the developer's.
//
// WHY. Ten agentic rows inherited the runner's real HOME, so the bundle read ~/.claude/settings.json, ran its hooks (an
// iTerm2 status hook blocking 30 s per call timed every one of them out in one suite) and wrote into the real ~/.claude
// (the headless plugin install restamped ~/.claude/plugins/known_marketplaces.json; native `doctor` in a fresh HOME
// writes ~/.claude.json and ~/.claude/backups). The first version of this guard read only env objects that set
// ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY, and so missed a `doctor` run with no env at all, `HOME: os.homedir()`,
// a process.env spread after the throwaway home, and an env built by assignment (review of fix round 1).
//
// WHAT IS READ: every JS file under test/ (test/.harness and test/fixtures aside) and scripts/lib/ (the helpers tests
// spawn the native through). test/bundle-spawn-scan.cjs finds each spawn of the bundle BY WHAT IS SPAWNED (the set is
// derived from a few seeds that name the bundle, through bindings, helpers and launchers) and judges the env it gets.
// EXEMPT, by name and reason, below; an exemption that matches nothing is itself a finding.
// FLOOR: the bundle spawns 2026-10-04's tree holds. CONTROL: the tree plus one planted file per evasion the first guard
// missed, each of which must be named.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { bundleSpawns } = require('./bundle-spawn-scan.cjs');

const REPO = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');
const LIB_DIR = path.join(REPO, 'scripts', 'lib');
const EXEMPT = [
  { where: /^fidelity\/interactive-live-turn\.test\.cjs:/, why: 'a deliberate opt-in (CLODE_LIVE_ONLINE) run with the developer\'s REAL '
    + 'credentials and config: its whole point is the real HOME' },
];
const FLOOR = 81;

function jsFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!['.harness', 'fixtures', 'node_modules'].includes(e.name)) out.push(...jsFiles(path.join(dir, e.name), r)); continue; }
    if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(r);
  }
  return out;
}
function read() {
  const files = jsFiles(TEST_DIR).map((f) => ({ file: f, src: fs.readFileSync(path.join(TEST_DIR, f), 'utf8') }))
    .concat(fs.readdirSync(LIB_DIR).filter((f) => /\.cjs$/.test(f)).map((f) => ({ file: `../scripts/lib/${f}`, src: fs.readFileSync(path.join(LIB_DIR, f), 'utf8') })));
  return { files, what: `${files.length} files under test/ and scripts/lib/` };
}
function scan({ files, what }) {
  const { spawns } = bundleSpawns(files);
  const findings = [], used = new Set();
  let examined = 0;
  for (const s of spawns) {
    const ex = EXEMPT.find((e) => e.where.test(s.where));
    if (ex) { used.add(ex); continue; }
    examined++;
    if (!s.ok) findings.push(`${s.where}: ${s.how} spawns the bundle, and ${s.why}: give it its own home (...throwawayHome(dir) or `
      + '...freshHome() from test/throwaway-home.cjs)');
  }
  for (const e of EXEMPT) if (!used.has(e) && files.some((f) => !/^planted/.test(f.file))) findings.push(`exemption ${e.where} matches no spawn of the bundle any more: remove it`);
  return { findings, examined, note: `${what}: ${examined} spawns of the bundle judged, ${spawns.length - examined} exempt by name` };
}

// One file per evasion the first guard missed. Each spawns the bundle (a built quaude named by its env variable).
const HEAD = "const { spawn, spawnSync } = require('node:child_process');\nconst os = require('node:os');\nconst path = require('node:path');\n"
  + "const { throwawayHome } = require('./throwaway-home.cjs');\nconst quaude = process.env.CLODE_QUAUDE;\n";
const PLANTS = {
  'planted-no-env.test.cjs': "spawnSync(quaude, ['doctor'], { encoding: 'utf8' });",
  'planted-homedir.test.cjs': "spawnSync(quaude, ['-p', 'x'], { env: { ...process.env, HOME: os.homedir(), CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') } });",
  'planted-bracket-home.test.cjs': "spawnSync(quaude, ['-p', 'x'], { env: { ...process.env, HOME: process.env['HOME'], CLAUDE_CONFIG_DIR: '/tmp/c' } });",
  'planted-ambient-config.test.cjs': "const home = '/tmp/h';\nspawnSync(quaude, ['-p', 'x'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });",
  'planted-late-spread.test.cjs': "spawnSync(quaude, ['-p', 'x'], { env: { ...throwawayHome('/tmp/d'), ...process.env, ANTHROPIC_API_KEY: 'k' } });",
  'planted-assigned.test.cjs': "const e = { ...process.env };\ne.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';\nspawn(quaude, ['-p', 'x'], { env: e });",
  'planted-own-home.test.cjs': "spawnSync(quaude, ['-p', 'x'], { env: { ...process.env, ...throwawayHome('/tmp/ok') } });",
};
const planted = () => Object.entries(PLANTS).map(([file, body]) => ({ file, src: HEAD + body }));
const control = () => ({ files: [...read().files, ...planted()], what: 'the tree plus one planted run per evasion' });

guardTests(defineGuard({ name: 'bundle-runs-own-home', floor: FLOOR, read, scan, control }));

test('each planted evasion is named, and the run with its own home is not', () => {
  const thisTree = read().files.filter((f) => f.file === 'throwaway-home.cjs');
  const { spawns } = bundleSpawns([...thisTree, ...planted()]);
  const verdict = Object.fromEntries(spawns.map((s) => [s.where.split(':')[0], s.ok ? 'ok' : s.why]));
  assert.deepStrictEqual(Object.keys(verdict).sort(), Object.keys(PLANTS).sort(), JSON.stringify(spawns, null, 1));
  assert.match(verdict['planted-no-env.test.cjs'], /set no env|no options/);
  assert.match(verdict['planted-homedir.test.cjs'], /HOME is the real home \("os\.homedir\(\)"\)/);
  assert.match(verdict['planted-bracket-home.test.cjs'], /HOME is the real home \("process\.env\['HOME'\]"\)/);
  assert.match(verdict['planted-ambient-config.test.cjs'], /CLAUDE_CONFIG_DIR is the real home \("process\.env\.CLAUDE_CONFIG_DIR"\)/);
  assert.match(verdict['planted-late-spread.test.cjs'], /spreads process\.env and no HOME of its own comes after it/);
  assert.match(verdict['planted-assigned.test.cjs'], /spreads process\.env and no HOME of its own comes after it/);
  assert.strictEqual(verdict['planted-own-home.test.cjs'], 'ok');
});

test('the derived spawn set reaches the bundle through each kind of route the tree uses', () => {
  const { spawns } = bundleSpawns(read().files);
  const where = spawns.map((s) => `${s.where} ${s.how}`).join('\n');
  for (const re of [
    /^doctor-cli-parity\.test\.cjs:\d+ doctor\(/m,                                  // a launcher with no env of its own (review G32)
    /^quaude-blobulated-win\.test\.cjs:\d+ spawnSync\("exe"\)/m,                  // --clode-attest, its own spawn
    /^node-shim-wall-tripwires\.test\.cjs:\d+ determineResolvedVersion\(/m,       // the provider's --version, two launchers deep
    /^fidelity\/agentic-tools\.test\.cjs:\d+ bootP\(/m,                            // cli.cjs under tjs, through engineSpawn
    /^e2e-tools\.test\.cjs:\d+ runNaudeModelAsync\(/m,                             // cli.cjs under node, through oracle-models
    /^e2e-tui-tjs\.test\.cjs:\d+ capture\(/m,                                      // a pty capture, after the driver's `--`
    /^fidelity\/rg-differential\.test\.cjs:\d+ runNativeRg\(/m,                    // the native as rg, through scripts/lib
    /^quaude-build\.test\.cjs:\d+ runQuaude\(.*-> spawn\("QUAUDE"\)/m,             // an env handed in by the caller
  ]) assert.match(where, re);
});

'use strict';
// autoupdater-off-gate — no Claude Code a test drives is left free to update its own install.
//
// THE CLASS: an instrument mutated mid-job. linux-x64-pty (CI 45354661143, 45381323279) installed the pinned native
// with `npm i -g`, drove it, and an hour later could not decode it. Native 2.1.330's TUI, on an npm-global install,
// asks the npm registry for @latest and runs `npm install -g @anthropic-ai/claude-code@<ver>` over itself; only
// DISABLE_AUTOUPDATER (or DISABLE_UPDATES / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / autoUpdates:false) stops it,
// and a mock ANTHROPIC_BASE_URL and a throwaway HOME do not (read from the carve; test/updater-off.cjs).
//
// WHAT THIS JUDGES, each as it is, not as its source reads:
//   - the env every spawning helper BUILDS, from a parent environment that lacks the knob (so the ambient default
//     cannot hide a helper that forgot it): tool-driver sideEnv, e2e-pty driveArgs, frame-oracle sceneEnv,
//     native-oracle preloadEnv, and the ambient default itself;
//   - the refusals: tui-screen.cjs (every PTY drive) exits refusing on an env with neither the knob nor a reason, and
//     the child_process tripwire refuses a native spawned with a constructed env that lacks it (the direct spawns
//     outside the helpers);
//   - that the two entry points install them: test/file-watchdog-preload.cjs (every CI `node --test` step and every
//     run.mjs test file; test/file-watchdog.test.cjs holds CI to loading it) and test/run.mjs.
// The CONTROL is tool-driver's env as it was built before 49081b0: no knob, from a parent with none.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');
const U = require('./updater-off.cjs');

const REPO = path.resolve(__dirname, '..');

function bareParent() {
  const env = { ...process.env };
  delete env[U.KNOB]; delete env[U.BECAUSE];
  return env;
}

// Does the tripwire refuse a native spawned with env `env`? Against a stub child_process: nothing is spawned.
function tripwireRefuses(env, file = '/opt/x/bin/claude', extra = {}) {
  const calls = [];
  const cp = { spawnSync: (...a) => { calls.push(a); return { status: 0 }; } };
  U.installSpawnTripwire(cp, { PATH: '/usr/bin' });
  try { cp.spawnSync(file, ['--version'], { env, ...extra }); } catch (e) { return /refusing to spawn/.test(e.message); }
  return calls.length === 0;
}

function read() {
  const parent = bareParent();
  const { sideEnv } = require('./tool-driver.cjs');
  const { driveArgs } = require('./e2e-pty.cjs');
  const { sceneEnv } = require('./frame-oracle.cjs');
  const { preloadEnv } = require('../scripts/lib/native-oracle.cjs');
  const envs = [
    { where: 'test/tool-driver.cjs sideEnv', env: sideEnv({ home: { HOME: '/h' }, mockUrl: 'http://127.0.0.1:1', parent }) },
    { where: 'test/e2e-pty.cjs driveArgs', env: driveArgs({ env: { PATH: '/usr/bin:/bin', HOME: '/h' } }, { seconds: 0, scriptFile: '/x/steps.json', cmd: ['/x/claude'] }).env },
    { where: 'test/frame-oracle.cjs sceneEnv', env: sceneEnv('http://127.0.0.1:1', {}, parent) },
    { where: 'scripts/lib/native-oracle.cjs preloadEnv', env: preloadEnv({ home: '/h', prog: '/p', outf: '/o', inf: '/i' }) },
    { where: 'test/updater-off.cjs ambient', env: U.ambient({ ...parent }) },
  ];
  // tui-screen refuses before it loads node-pty or spawns anything, so this needs no harness and runs nothing.
  const tripForms = [];
  const ts = spawnSync(process.execPath, [path.join(__dirname, 'tui-screen.cjs'), '1', '--', process.execPath, '-e', '0'],
    { encoding: 'utf8', env: parent, timeout: 30000 });
  // Every form a Claude Code is started in (2026-11-25: the first tripwire saw only `claude` through four functions).
  const forms = [
    ['spawnSync', ['/x/quaude-macos-arm64', ['-p', 'hi']], 'a built quaude'],
    ['spawnSync', [process.execPath, ['--no-warnings', '/s/cli.cjs', '-p']], 'naude: node running the extracted bundle'],
    ['spawn', ['claude -p hi', [], {}], 'spawn with shell: true', true],
    ['execSync', ['cd /w && claude --version'], 'execSync of a shell string'],
    ['exec', ['FOO=1 timeout 30 /opt/bin/claude -p x'], 'exec through assignments and a wrapper'],
    ['fork', ['/s/cli.cjs', []], 'fork of the bundle'],
  ];
  for (const [fn, a, what, shell] of forms) {
    const cp = { [fn]: () => ({ status: 0 }) };
    U.installSpawnTripwire(cp, { PATH: '/usr/bin' });
    const args = a.slice();
    const opts = { env: { HOME: '/h' }, ...(shell ? { shell: true } : {}) };
    if (fn === 'exec' || fn === 'execSync') args.splice(1, 0, opts); else args.length >= 2 ? args.splice(2, 1, opts) : args.push([], opts);
    let refused = false;
    try { cp[fn](...args); } catch (e) { refused = /refusing to spawn/.test(e.message); }
    tripForms.push({ where: `child_process tripwire refuses ${what} (${fn})`, refused });
  }
  // ...and the outermost ambient default: every workflow sets the knob for every job (scripts outside the runner too).
  const wfDir = path.join(REPO, '.github', 'workflows');
  for (const f of fs.readdirSync(wfDir).filter((n) => !n.startsWith('.') && /\.ya?ml$/.test(n)).sort()) {
    const text = fs.readFileSync(path.join(wfDir, f), 'utf8');
    tripForms.push({ where: `.github/workflows/${f} sets DISABLE_AUTOUPDATER: '1' at the top level`,
      refused: /^env:\n(?:[ ]{2}.*\n)*?[ ]{2}DISABLE_AUTOUPDATER: '1'\s*$/m.test(text) });
  }
  const preload = fs.readFileSync(path.join(__dirname, 'file-watchdog-preload.cjs'), 'utf8');
  const runMjs = fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8');
  const refusals = [
    { where: 'test/tui-screen.cjs refuses an env without the knob',
      refused: ts.status !== 0 && /refusing to spawn a Claude Code/.test(ts.stderr || '') },
    { where: 'child_process tripwire refuses a native spawned with a constructed env', refused: tripwireRefuses({ HOME: '/h' }) },
    { where: 'test/file-watchdog-preload.cjs installs the ambient knob and the tripwire',
      refused: /\.ambient\(process\.env\)/.test(preload) && /\.installSpawnTripwire\(\)/.test(preload) },
    { where: 'test/run.mjs sets the ambient knob', refused: /updater-off\.cjs'\)\.ambient\(process\.env\)/.test(runMjs) },
    ...tripForms,
  ];
  return { envs, refusals };
}

// PURE.
function scan({ envs, refusals }) {
  const findings = [];
  for (const { where, env } of envs) {
    const w = U.whyUpdaterOn(env);
    if (w) findings.push(`${where}: builds a Claude Code env where ${w}, and no ${U.BECAUSE}`);
  }
  for (const { where, refused } of refusals) if (!refused) findings.push(`${where}: does not`);
  return { findings, examined: envs.length + refusals.length,
    note: `${envs.length} helper-built envs, ${refusals.length} refusals/installs` };
}

guardTests(defineGuard({
  name: 'autoupdater-off',
  floor: 25,
  read,
  scan,
  control() {
    // tool-driver.cjs runSide's env before 49081b0, verbatim in shape, from a CI parent that had no knob.
    const parent = { PATH: '/usr/bin:/bin', HOME: '/runner', CI: 'true' };
    const home = { HOME: '/tmp/side/home' };
    const old = { ...parent, ...home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'sk-ant-mock' };
    return { envs: [{ where: 'tool-driver runSide (pre-49081b0)', env: old }], refusals: [] };
  },
}));

test('updater-off: the knob, the written opt-out, and a reason carried from one helper to the next', () => {
  assert.strictEqual(U.updaterOff({})[U.KNOB], '1');
  const off = U.updaterOff({ [U.KNOB]: '1' }, 'exercises the updater');
  assert.strictEqual(off[U.KNOB], undefined);
  assert.strictEqual(off[U.BECAUSE], 'exercises the updater');
  assert.deepStrictEqual(U.updaterOff(off), off, 'a reason decided upstream (tool-driver -> e2e-pty) is kept');
  assert.throws(() => U.updaterOff({}, '  '), /non-empty written reason/);
  assert.throws(() => U.refuseUpdaterOn({ [U.KNOB]: '0' }, 'x'), /DISABLE_AUTOUPDATER="0"/);
  assert.doesNotThrow(() => U.refuseUpdaterOn(off, 'x'));
  assert.strictEqual(U.ambient({ [U.BECAUSE]: 'r' })[U.KNOB], undefined, 'ambient never overrides a decision');
});

test('updater-off tripwire: what it refuses and what it passes over', () => {
  assert.strictEqual(tripwireRefuses({ HOME: '/h' }), true, 'a `claude` with a constructed env');
  assert.strictEqual(tripwireRefuses({ HOME: '/h', [U.KNOB]: '1' }), false, 'with the knob');
  assert.strictEqual(tripwireRefuses({ HOME: '/h', [U.BECAUSE]: 'why' }), false, 'with a written reason');
  assert.strictEqual(tripwireRefuses({ HOME: '/h' }, '/usr/bin/env'), false, 'not a Claude Code');
  assert.strictEqual(tripwireRefuses({ HOME: '/h' }, '/opt/x/bin/claude', { argv0: 'rg' }), false, 'native as its embedded rg');
  // The path a native-resolving variable names is native whatever it is called (a staged provider-min, say).
  const cp = { spawnSync: () => ({ status: 0 }) };
  U.installSpawnTripwire(cp, { CLODE_PROVIDER_BIN: '/s/provider-min' });
  assert.throws(() => cp.spawnSync('/s/provider-min', [], { env: { HOME: '/h' } }), /refusing to spawn/);
  // A shell string: the command words, not any word; an inline knob passes; something else named claude-ish does not trip.
  assert.strictEqual(U.shellStartsClaude('DISABLE_AUTOUPDATER=1 claude -p x', {}), 'off');
  assert.strictEqual(U.shellStartsClaude('echo claude', {}), false, 'an argument, not a command');
  assert.strictEqual(U.shellStartsClaude('command -v claude', {}), false, '`command -v` looks it up, it does not run it');
  assert.strictEqual(U.shellStartsClaude('ls | env -i HOME=/h claude --version', {}), true);
  assert.strictEqual(U.isClaudeCode(process.execPath, ['test/x.cjs'], {}), false, 'node running anything else');
  assert.strictEqual(U.isClaudeCode('/e/tjs', ['run', '/b/cli.cjs'], {}), true, 'the engine running the bundle unbuilt');
  assert.strictEqual(U.isClaudeCode('/e/tjs', ['run', '/l/loader.js', '/b/cli.cjs'], {}), true, 'through quaude\'s loader');
  assert.strictEqual(U.isClaudeCode(process.execPath, ['/x/extract-claude-js.cjs', '/p/claude', '/o/cli.cjs'], {}), false,
    'node writing a cli.cjs is not node running one');
  // No options: the child inherits the parent's env, which is what is judged.
  const cp2 = { execFileSync: () => '' };
  U.installSpawnTripwire(cp2, { PATH: '/usr/bin' });
  assert.throws(() => cp2.execFileSync('claude', ['--version']), /refusing to spawn/);
});

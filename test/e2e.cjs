'use strict';
// Shared end-to-end harness for node:test launcher tests — the node-native successor
// to test_helper.bash's bash sandbox. Every clode subprocess is spawned with a
// CONSTRUCTED-CLEAN env (nothing from the real process.env), so no test can read or
// write real machine state (the hermetic-guard enforces it) and the suite is
// Windows-portable (no bash). Pure Node stdlib.
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'bin', 'clode');
const NODE = process.env.CLODE_NODE || process.execPath;
const MKFIXTURE = path.join(REPO, 'test', 'mkfixture.cjs');

// The render ext-deps clode's TUI requires. Functional fakes (the same
// 0.0.0-clode-test stubs the bash harness used) so offline render paths resolve
// without a real npm install. Bodies copied verbatim from test_helper.bash.
const RENDER_FAKES = {
  'string-width': "module.exports = (s) => [...String(s).replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g, '')].length;\n",
  'strip-ansi': "module.exports = (s) => String(s).replace(/\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g, '');\n",
  'wrap-ansi': "module.exports = (s) => String(s);\n",
  'semver': "const P = (v) => String(v).replace(/^[v=]+/, '').split('.').map((n) => parseInt(n, 10) || 0);\n"
    + "exports.compare = (a, b) => { const x = P(a), y = P(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) < (y[i]||0) ? -1 : 1; return 0; };\n"
    + "exports.satisfies = () => true;\n",
};

function seedRenderDeps(nodeModulesDir) {
  for (const pkg of Object.keys(RENDER_FAKES)) {
    const d = path.join(nodeModulesDir, pkg);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'),
      JSON.stringify({ name: pkg, version: '0.0.0-clode-test', main: 'index.js' }) + '\n');
    fs.writeFileSync(path.join(d, 'index.js'), RENDER_FAKES[pkg]);
  }
}

// Create a private, disposable sandbox for one test. Pass the node:test `t` so cleanup
// registers via t.after (deterministic — no teardown race). NOTHING from process.env
// leaks in.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-e2e-'));
  const home = path.join(dir, 'home');
  const stateRoot = dir;
  fs.mkdirSync(home, { recursive: true });
  seedRenderDeps(path.join(stateRoot, 'share', 'clode', 'node_modules'));
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    CLODE_STATE_ROOT: stateRoot,
    CLODE_NODE: NODE,
    CLODE_NO_WATCH: '1',
    CLODE_OFFLINE: '1',
  };
  if (t && typeof t.after === 'function') {
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return { dir, home, stateRoot, env };
}

// Spawn bin/clode with the sandbox env. opts.env merges over sbx.env; opts.input is
// stdin. Returns status/signal/stdout/stderr plus `output` = stdout+stderr (matching
// bats `run`'s merged $output).
function runClode(sbx, args = [], opts = {}) {
  const r = spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...sbx.env, ...(opts.env || {}) },
    input: opts.input,
    cwd: opts.cwd || REPO,
  });
  return {
    status: r.status, signal: r.signal,
    stdout: r.stdout || '', stderr: r.stderr || '',
    output: (r.stdout || '') + (r.stderr || ''),
  };
}

// Fake provider binary at `dest`, printing "CLODE-FIXTURE <label>" when booted.
function mkProvider(dest, label) {
  execFileSync(NODE, [MKFIXTURE, dest, label]);
  return dest;
}

module.exports = { sandbox, runClode, mkProvider, seedRenderDeps, REPO, BIN, NODE };

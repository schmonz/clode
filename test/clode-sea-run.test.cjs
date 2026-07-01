'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const NODE = process.env.CLODE_NODE || process.execPath;
const CLODE_MAIN = path.join(REPO, 'libexec', 'clode-main.cjs');
const ECHO = path.join(REPO, 'test', 'fixtures', 'sea-run-echo.cjs');
const run = require('../libexec/clode-run.cjs');

test('runAsNodeIfRequested: sentinel makes clode-main run the script as node, stripped', () => {
  // Spawn clode-main as main (its self-run guard calls runAsNodeIfRequested FIRST).
  // With the sentinel set and argv [<script>, a, b], it must run <script> with
  // argv.slice(2) === ['a','b'] and the sentinel deleted from the child's env.
  const r = spawnSync(NODE, [CLODE_MAIN, ECHO, 'a', 'b'], {
    encoding: 'utf8',
    env: { ...process.env, CLODE_SEA_RUN_AS_NODE: '1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.args, ['a', 'b']);
  assert.strictEqual(out.sentinel, 'absent', 'sentinel must be stripped before the script runs');
  // require(script) does NOT make the script require.main (that stays clode-main).
  // This is fine: the extracted cli.cjs runs on load and never gates on
  // import.meta.main (require.main === module), so booting it via require() works.
  assert.strictEqual(out.isMain, false);
});

test('without the sentinel, clode-main does NOT enter run-as-node mode', () => {
  // No sentinel: clode-main dispatches normally. --clode-version proves it took the
  // normal path (and did not try to require ECHO as a script).
  const r = spawnSync(NODE, [CLODE_MAIN, '--clode-version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^clode \d+\.\d+\.\d+/);
});

test('runBundle under SEA: spawns self with the sentinel and [cliPath, ...args]', () => {
  let captured = null;
  const fakeChild = { on() {}, kill() {} };
  const env = {};
  run.runBundle({
    node: '/some/host/node',       // must be IGNORED under SEA (self wins)
    cliPath: '/cache/cli.cjs',
    args: ['--foo', 'bar'],
    settingsPath: null,
    self: '/path/to/clode',
    libexec: path.join(REPO, 'libexec'),
    env,
    isSea: () => true,
    spawn: (cmd, argv, o) => { captured = { cmd, argv, o }; return fakeChild; },
    procOn: () => {}, procOff: () => {}, exit: () => {}, stderr: { write() {} },
  });
  assert.strictEqual(captured.cmd, process.execPath, 'SEA must spawn the SEA binary itself');
  assert.deepStrictEqual(captured.argv, ['/cache/cli.cjs', '--foo', 'bar']);
  assert.strictEqual(captured.o.env.CLODE_SEA_RUN_AS_NODE, '1');
});

test('runBundle under non-SEA: uses the given node, no sentinel', () => {
  let captured = null;
  const fakeChild = { on() {}, kill() {} };
  const env = {};
  run.runBundle({
    node: '/some/host/node',
    cliPath: '/cache/cli.cjs',
    args: ['x'],
    settingsPath: null,
    self: '/path/to/clode',
    libexec: path.join(REPO, 'libexec'),
    env,
    isSea: () => false,
    spawn: (cmd, argv, o) => { captured = { cmd, argv, o }; return fakeChild; },
    procOn: () => {}, procOff: () => {}, exit: () => {}, stderr: { write() {} },
  });
  assert.strictEqual(captured.cmd, '/some/host/node');
  assert.deepStrictEqual(captured.argv, ['/cache/cli.cjs', 'x']);
  assert.strictEqual(captured.o.env.CLODE_SEA_RUN_AS_NODE, undefined);
});

'use strict';
// The oracle's two runtime models, decoupled from bin/clode (the runner Phase 3
// deletes). naude-model = `node cli.cjs` (real Node built-ins — the reference);
// quaude-model = `tjs run loader cli.cjs` (the node-shim — the subject).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runNaudeModel, runQuaudeModel, REPO } = require('./oracle-models.cjs');

test('quaude-model runs cli.cjs under tjs + the node-shim loader', () => {
  let c = null;
  runQuaudeModel('/x/cli.cjs', ['-p', 'hi'], {
    tjs: '/t/tjs',
    spawn: (cmd, args, opts) => { c = { cmd, args, env: opts.env }; return { status: 0 }; },
  });
  assert.strictEqual(c.cmd, '/t/tjs');
  assert.deepStrictEqual(c.args, ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), '/x/cli.cjs', '-p', 'hi']);
  assert.match(c.env.NODE_PATH, /node_modules/);
});

test('naude-model runs cli.cjs under node directly (native built-ins, no node-shim)', () => {
  let c = null;
  runNaudeModel('/x/cli.cjs', ['-p', 'hi'], {
    node: '/n/node',
    spawn: (cmd, args, opts) => { c = { cmd, args, env: opts.env }; return { status: 0 }; },
  });
  assert.strictEqual(c.cmd, '/n/node');
  assert.deepStrictEqual(c.args, ['/x/cli.cjs', '-p', 'hi']);
  assert.match(c.env.NODE_PATH, /node_modules/);
});

test('neither model consults CLODE_ENGINE or bin/clode', () => {
  let c = null;
  runQuaudeModel('/x/cli.cjs', [], {
    tjs: '/t/tjs',
    env: { CLODE_ENGINE: 'node' },
    spawn: (cmd, args, opts) => { c = { cmd, args, env: opts.env }; return { status: 0 }; },
  });
  assert.strictEqual(c.env.CLODE_ENGINE, undefined, 'the model runners must not honor the retired engine selector');
  assert.ok(!/bin[/\\]clode/.test(c.cmd), 'must not route through the runner');
});

test('both models return the spawn result shape', () => {
  const fake = { status: 3, signal: null, stdout: 'out', stderr: 'err' };
  const r = runNaudeModel('/x/cli.cjs', [], { node: '/n/node', spawn: () => fake });
  assert.deepStrictEqual(r, { status: 3, signal: null, stdout: 'out', stderr: 'err' });
});

// The async variants exist because the mock Anthropic server lives IN the test
// process: spawnSync blocks this event loop, so the mock could never answer the
// child's POST and the child hangs forever. Same argv, non-blocking dispatch.
test('async models build the SAME argv as their sync twins', async () => {
  const { runNaudeModelAsync, runQuaudeModelAsync } = require('./oracle-models.cjs');
  const seen = [];
  const fakeSpawn = (cmd, args) => {
    seen.push({ cmd, args });
    return {
      stdout: { on() {} }, stderr: { on() {} },
      on: (ev, cb) => { if (ev === 'exit') setImmediate(() => cb(0, null)); },
      kill() {},
    };
  };
  await runNaudeModelAsync('/x/cli.cjs', ['-p', 'hi'], { node: '/n/node', spawn: fakeSpawn });
  await runQuaudeModelAsync('/x/cli.cjs', ['-p', 'hi'], { tjs: '/t/tjs', spawn: fakeSpawn });
  assert.deepStrictEqual(seen[0], { cmd: '/n/node', args: ['/x/cli.cjs', '-p', 'hi'] });
  assert.deepStrictEqual(seen[1], { cmd: '/t/tjs', args: ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), '/x/cli.cjs', '-p', 'hi'] });
});

test('async models collect output and resolve on exit', async () => {
  const { runNaudeModelAsync } = require('./oracle-models.cjs');
  const r = await runNaudeModelAsync('/x/cli.cjs', [], {
    node: '/n/node',
    spawn: () => ({
      stdout: { on: (e, cb) => { if (e === 'data') cb('PONG'); } },
      stderr: { on: (e, cb) => { if (e === 'data') cb('warn'); } },
      on: (ev, cb) => { if (ev === 'exit') setImmediate(() => cb(0, null)); },
      kill() {},
    }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'PONG');
  assert.strictEqual(r.stderr, 'warn');
  assert.ok(typeof r.ms === 'number');
});

test('caller env is preserved and NODE_PATH is prepended, not clobbered', () => {
  let c = null;
  runNaudeModel('/x/cli.cjs', [], {
    node: '/n/node',
    env: { ANTHROPIC_BASE_URL: 'http://mock', NODE_PATH: '/pre-existing' },
    spawn: (cmd, args, opts) => { c = { cmd, args, env: opts.env }; return { status: 0 }; },
  });
  assert.strictEqual(c.env.ANTHROPIC_BASE_URL, 'http://mock');
  assert.strictEqual(c.env.NODE_PATH, path.join(REPO, 'deps', 'claude', 'node_modules') + path.delimiter + '/pre-existing');
});

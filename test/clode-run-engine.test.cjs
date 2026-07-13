'use strict';
// The CLODE_ENGINE=tjs branch spawns tjs+loader; the default path is unchanged.
// runBundle's spawn/procOn/procOff/exit are injected so nothing actually launches.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runBundle } = require('../libexec/clode-run.cjs');

function capture(env) {
  const calls = [];
  const child = { on() {}, kill() {} };
  runBundle({
    node: '/usr/bin/node', cliPath: '/cache/cli.cjs', args: ['--version'],
    settingsPath: null, self: '/bin/clode', libexec: '/libexec', env,
    spawn: (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return child; },
    procOn: () => {}, procOff: () => {}, exit: () => {}, stderr: { write() {} },
  });
  return calls[0];
}

test('default path unchanged: spawns node cli.cjs directly', () => {
  const c = capture({ PATH: '/usr/bin' });
  assert.strictEqual(c.cmd, '/usr/bin/node');
  assert.deepStrictEqual(c.argv, ['/cache/cli.cjs', '--version']);
});

test('CLODE_ENGINE=tjs: spawns tjs run <loader> cli.cjs --version', () => {
  const c = capture({ PATH: '/usr/bin', CLODE_ENGINE: 'tjs', CLODE_TJS: '/opt/tjs' });
  assert.strictEqual(c.cmd, '/opt/tjs');
  assert.strictEqual(c.argv[0], 'run');
  // path.join is separator-native (backslashes on win32), so build the
  // expected loader path the same way the product does.
  assert.strictEqual(c.argv[1], path.join('/libexec', 'node-shim', 'loader.cjs'));
  assert.strictEqual(c.argv[2], '/cache/cli.cjs');
  assert.deepStrictEqual(c.argv.slice(3), ['--version']);
});

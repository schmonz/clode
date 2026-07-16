'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runNaude } = require('../libexec/naude-entry.cjs');

function fakeSea() {
  const assets = { 'cli.cjs': 'CLI', 'bun-shim.cjs': 'SHIM', 'deps.tar': '', 'deps.sig': 'sig0' };
  return { isSea: () => true, getRawAsset: (n) => { const b = Buffer.from(assets[n] || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}

test('first pass (isSea, no sentinel) re-invokes execPath in run-as-node with cli.cjs + NODE_PATH', () => {
  let call = null; let exited = null;
  runNaude({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: {}, cacheDir: require('os').tmpdir(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    workDir: '/work',
    spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return { on(){}, }; },
    procOn: () => {}, procOff: () => {}, exit: (c) => { exited = c; },
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.cmd, '/naude');
  assert.strictEqual(call.opts.env.NAUDE_RUN_AS_NODE, '/work/cli.cjs');
  assert.match(call.opts.env.NODE_PATH, /\/deps\/node_modules/);
  assert.deepStrictEqual(call.args, ['--version']);
  assert.strictEqual(exited, 0);
});

test('second pass (sentinel set) runs the target cli.cjs as main', () => {
  let required = null;
  runNaude({
    argv: ['--version'], execPath: '/naude',
    env: { NAUDE_RUN_AS_NODE: '/work/cli.cjs' },
    requireMain: (p, argv) => { required = { p, argv }; },
  });
  assert.strictEqual(required.p, '/work/cli.cjs');
  assert.deepStrictEqual(required.argv, ['/naude', '/work/cli.cjs', '--version']);
});

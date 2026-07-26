'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBuildArgs } = require('../libexec/clode-fuse.cjs');

test('parseBuildArgs: --list-targets', () => {
  assert.deepStrictEqual(parseBuildArgs(['--list-targets']),
    { naude: false, self: false, out: null, target: null, listTargets: true });
});

test('parseBuildArgs: --target Y [--out P]', () => {
  const p = parseBuildArgs(['--target', 'linux-x64', '--out', 'q']);
  assert.strictEqual(p.target, 'linux-x64');
  assert.strictEqual(p.out, 'q');
});

test('parseBuildArgs: --target needs a value', () => {
  assert.match(parseBuildArgs(['--target']).error, /--target needs a platform/);
});

test('parseBuildArgs: --target and --self/--naude are exclusive', () => {
  assert.match(parseBuildArgs(['--target', 'linux-x64', '--self']).error, /different build targets/);
});

test('parseBuildArgs: plain build unchanged', () => {
  assert.deepStrictEqual(parseBuildArgs([]),
    { naude: false, self: false, out: null, target: null, listTargets: false });
});

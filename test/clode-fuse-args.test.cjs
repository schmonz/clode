'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBuildArgs, defaultBuildOut } = require('../libexec/clode-fuse.cjs');

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

// defaultBuildOut: the .exe suffix follows the TARGET platform, not the host —
// the cross-build naming bug (keying off process.platform got both backwards).
test('defaultBuildOut: .exe follows the target, not the host', () => {
  // windows target from a POSIX host -> still .exe
  assert.strictEqual(defaultBuildOut({ target: 'windows-x64', self: false, hostPlatform: 'linux' }), 'quaude.exe');
  assert.strictEqual(defaultBuildOut({ target: 'windows-arm64', self: false, hostPlatform: 'darwin' }), 'quaude.exe');
  // POSIX target from a Windows host -> NO .exe
  assert.strictEqual(defaultBuildOut({ target: 'netbsd-sparc', self: false, hostPlatform: 'win32' }), 'quaude');
  assert.strictEqual(defaultBuildOut({ target: 'linux-x64', self: false, hostPlatform: 'win32' }), 'quaude');
});

test('defaultBuildOut: no --target follows the host; --self names clode-native', () => {
  assert.strictEqual(defaultBuildOut({ target: null, self: false, hostPlatform: 'win32' }), 'quaude.exe');
  assert.strictEqual(defaultBuildOut({ target: null, self: false, hostPlatform: 'linux' }), 'quaude');
  assert.strictEqual(defaultBuildOut({ target: null, self: true, hostPlatform: 'win32' }), 'clode-native.exe');
  assert.strictEqual(defaultBuildOut({ target: 'windows-x64', self: true, hostPlatform: 'linux' }), 'clode-native.exe');
  assert.strictEqual(defaultBuildOut({ target: null, self: true, hostPlatform: 'linux' }), 'clode-native');
});

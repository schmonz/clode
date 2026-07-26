'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBuildArgs, resolveBuildOut } = require('../libexec/clode-fuse.cjs');

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

// resolveBuildOut: the .exe suffix follows the TARGET platform, not the host —
// the cross-build naming bug (keying off process.platform got both backwards).
test('resolveBuildOut: default name — .exe follows the target, not the host', () => {
  // windows target from a POSIX host -> still .exe
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-x64', self: false, hostPlatform: 'linux' }), 'quaude.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-arm64', self: false, hostPlatform: 'darwin' }), 'quaude.exe');
  // POSIX target from a Windows host -> NO .exe
  assert.strictEqual(resolveBuildOut({ out: null, target: 'netbsd-sparc', self: false, hostPlatform: 'win32' }), 'quaude');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'linux-x64', self: false, hostPlatform: 'win32' }), 'quaude');
});

test('resolveBuildOut: an explicit --out for a windows target gains .exe if missing', () => {
  // the field-report case: `--out quaude-windows-x64` must run on Windows
  assert.strictEqual(resolveBuildOut({ out: 'quaude-windows-x64', target: 'windows-x64', self: false, hostPlatform: 'linux' }), 'quaude-windows-x64.exe');
  // already has .exe -> not doubled (case-insensitive)
  assert.strictEqual(resolveBuildOut({ out: 'q.exe', target: 'windows-x64', self: false, hostPlatform: 'linux' }), 'q.exe');
  assert.strictEqual(resolveBuildOut({ out: 'q.EXE', target: 'windows-x64', self: false, hostPlatform: 'linux' }), 'q.EXE');
  // non-windows target -> explicit --out respected verbatim, no .exe appended
  assert.strictEqual(resolveBuildOut({ out: 'quaude-netbsd-sparc', target: 'netbsd-sparc', self: false, hostPlatform: 'win32' }), 'quaude-netbsd-sparc');
});

test('resolveBuildOut: a NATIVE windows build (no --target) keeps its explicit --out verbatim', () => {
  // REGRESSION (release 0.20260727.1): the windows BUILDER leg runs
  // `clode build --self --out clode-<ver>-windows-x64` on a windows host; the
  // attest/publish steps expect that EXACT bare name. Appending .exe here (as an
  // over-eager host-based rule did) makes the leg fail "Could not find subject at
  // path clode-<ver>-windows-x64". Native explicit --out must be untouched.
  assert.strictEqual(resolveBuildOut({ out: 'clode-1.2.3-windows-x64', target: null, self: true, hostPlatform: 'win32' }), 'clode-1.2.3-windows-x64');
  assert.strictEqual(resolveBuildOut({ out: 'quaude-x', target: null, self: false, hostPlatform: 'win32' }), 'quaude-x');
});

test('resolveBuildOut: no --target follows the host; --self names clode-native', () => {
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: false, hostPlatform: 'win32' }), 'quaude.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: false, hostPlatform: 'linux' }), 'quaude');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: true, hostPlatform: 'win32' }), 'clode-native.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-x64', self: true, hostPlatform: 'linux' }), 'clode-native.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: true, hostPlatform: 'linux' }), 'clode-native');
});

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  macosVersion, linuxGlibc, osToken, platformTag, seaOut, seaBin,
} = require('../scripts/platform-tag.cjs');

test('macosVersion keeps two components only for the 10.x era', () => {
  assert.strictEqual(macosVersion('10.9.5'), '10.9');
  assert.strictEqual(macosVersion('10.15'), '10.15');
  assert.strictEqual(macosVersion('14.7.1'), '14');
  assert.strictEqual(macosVersion('26.0'), '26');
});

test('linuxGlibc reports the compiler glibc, else musl', () => {
  assert.strictEqual(linuxGlibc({ header: { glibcVersionCompiler: '2.28' } }), 'glibc2.28');
  assert.strictEqual(linuxGlibc({ header: {} }), 'musl');
  assert.strictEqual(linuxGlibc(null), 'musl');
});

test('osToken composes the platform prefix with the version token', () => {
  // Only exercise the branch for the CURRENT host: osToken('darwin') shells out to
  // `sw_vers`, which is absent on Linux (and vice-versa the linux branch reads
  // process.report), so testing the other platform's branch would throw off-host.
  if (process.platform === 'darwin') assert.match(osToken('darwin'), /^macos-(10\.\d+|\d+)$/);
  if (process.platform === 'linux') assert.match(osToken('linux'), /^linux-(glibc\d+\.\d+|musl)$/);
  // unknown platforms use only os.release() → safe to assert everywhere.
  assert.match(osToken('freebsd'), /^freebsd-\d+$/);
});

test('platformTag is a pure formatter over an injected token', () => {
  assert.strictEqual(
    platformTag({ token: 'macos-14', arch: 'arm64', nodeVersion: '24.18.0' }),
    'macos-14-arm64-node24');
  assert.strictEqual(
    platformTag({ token: 'linux-glibc2.28', arch: 'x64', nodeVersion: '24.5.0' }),
    'linux-glibc2.28-x64-node24');
});

test('platformTag() with no args produces the host tuple', () => {
  assert.match(platformTag(), /^(macos-(10\.\d+|\d+)|linux-(glibc\d+\.\d+|musl)|windows|\w+-\d+)-\S+-node\d+$/);
});

test('osToken maps win32 to the stable "windows" token (no OS-version split)', () => {
  assert.strictEqual(osToken('win32'), 'windows');
});

test('seaOut is <repo>/build/<tag>/<base>', () => {
  assert.strictEqual(seaOut('/r', 'naude'), path.join('/r', 'build', platformTag(), 'naude'));
});

test('seaBin is seaOut plus the platform exe suffix', () => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  assert.strictEqual(seaBin('/r', 'naude'), seaOut('/r', 'naude') + suffix);
});

test('seaBin/seaOut honor the base param (not hardcoded)', () => {
  assert.ok(seaOut('/r', 'clode').endsWith(path.join('build', platformTag(), 'clode')));
  assert.ok(seaBin('/r', 'clode').includes('clode'));
});

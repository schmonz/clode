const { test } = require('node:test');
const assert = require('node:assert');
const {
  macosVersion, linuxGlibc, osToken, platformTag,
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
  assert.match(platformTag(), /^(macos-(10\.\d+|\d+)|linux-(glibc\d+\.\d+|musl)|\w+-\d+)-\S+-node\d+$/);
});

test('osToken maps win32 to the stable "windows" token (no OS-version split)', () => {
  assert.strictEqual(osToken('win32'), 'windows');
});

test('seaBin names the SEA output binary — .exe only on win32', () => {
  const path = require('node:path');
  const { seaBin } = require('../scripts/platform-tag.cjs');
  assert.strictEqual(path.basename(seaBin('/repo', 'win32')), 'clode.exe');
  assert.strictEqual(path.basename(seaBin('/repo', 'linux')), 'clode');
  assert.strictEqual(path.basename(seaBin('/repo', 'darwin')), 'clode');
});

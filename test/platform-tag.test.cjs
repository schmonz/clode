const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  macosVersion, linuxGlibc, osToken, platformTag, toolchainDir,
  hostOsVersionToken, artifactName, artifactDir, seaOut, seaBin,
  tjsDir, tjsBin,
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

test('toolchainDir is <repo>/build/toolchain/<platformTag>', () => {
  assert.strictEqual(toolchainDir('/r'), path.join('/r', 'build', 'toolchain', platformTag()));
});

test('tjsDir is <repo>/build/tjs/<osToken>-<arch> — keyed by OS+arch only, NOT node major', () => {
  // Pure formatter over injected token/arch (like platformTag/artifactName).
  assert.strictEqual(
    tjsDir('/r', { token: 'netbsd-11', arch: 'arm64' }),
    path.join('/r', 'build', 'tjs', 'netbsd-11-arm64'));
  assert.strictEqual(
    tjsDir('/r', { token: 'linux-glibc2.28', arch: 'x64' }),
    path.join('/r', 'build', 'tjs', 'linux-glibc2.28-x64'));
  // host default = osToken()-arch; tjs is a native C binary, node-independent,
  // so its key must NOT carry a node major (that would wrongly split the cache).
  assert.strictEqual(tjsDir('/r'), path.join('/r', 'build', 'tjs', `${osToken()}-${process.arch}`));
  assert.doesNotMatch(tjsDir('/r'), /node\d+/);
});

test('tjsBin is <tjsDir>/tjs (host exe suffix)', () => {
  const exe = process.platform === 'win32' ? 'tjs.exe' : 'tjs';
  assert.strictEqual(
    tjsBin('/r', { token: 'netbsd-11', arch: 'arm64' }),
    path.join('/r', 'build', 'tjs', 'netbsd-11-arm64', exe));
});

test('hostOsVersionToken: darwin is the canonical dashed "macos-<ver>", padded to major.minor', () => {
  if (process.platform !== 'darwin') return;
  assert.match(hostOsVersionToken('darwin'), /^macos-(10\.\d+|\d+\.\d+)$/);
  assert.doesNotMatch(hostOsVersionToken('darwin'), /^darwin/);
});

test('hostOsVersionToken: win32 is the bare "windows" token (no floor exists to match)', () => {
  assert.strictEqual(hostOsVersionToken('win32'), 'windows');
});

test('hostOsVersionToken: unknown platforms degrade honestly (no invented floor)', () => {
  assert.match(hostOsVersionToken('freebsd'), /^freebsd-\d+$/);
});

test('artifactName is a pure formatter: clode-<version>-<token>-<arch>', () => {
  assert.strictEqual(
    artifactName({ version: '0.1.3', token: 'macos-11.0', arch: 'arm64' }),
    'clode-0.1.3-macos-11.0-arm64');
});

test('artifactName canonicalizes the arch (x64->amd64, ia32->i386)', () => {
  assert.strictEqual(
    artifactName({ version: '0.1.3', token: 'macos-10.6', arch: 'x64' }),
    'clode-0.1.3-macos-10.6-amd64');
  assert.strictEqual(
    artifactName({ version: '0.1.3', token: 'macos-10.4', arch: 'ia32' }),
    'clode-0.1.3-macos-10.4-i386');
});

test('artifactName defaults token to hostOsVersionToken() (the host, not a floor)', () => {
  assert.strictEqual(
    artifactName({ version: '0.1.3', arch: 'arm64' }),
    `clode-0.1.3-${hostOsVersionToken()}-arm64`);
});

test('artifactDir is <repo>/build/<artifactName>', () => {
  assert.strictEqual(
    artifactDir('/r', { version: '0.1.3', env: {} }),
    path.join('/r', 'build', artifactName({ version: '0.1.3' })));
});

test('artifactDir: CLODE_ASSET_NAME overrides the WHOLE name (CI floor support)', () => {
  assert.strictEqual(
    artifactDir('/r', { version: '0.1.3', env: { CLODE_ASSET_NAME: 'clode-0.1.3-macos-11.0-arm64' } }),
    path.join('/r', 'build', 'clode-0.1.3-macos-11.0-arm64'));
});

test('seaOut is <repo>/build/<artifactName>/<base>, not the toolchain tag', () => {
  assert.strictEqual(
    seaOut('/r', 'naude', { version: '0.1.3', env: {} }),
    path.join('/r', 'build', artifactName({ version: '0.1.3' }), 'naude'));
  assert.notStrictEqual(seaOut('/r', 'naude', { version: '0.1.3', env: {} }),
    path.join('/r', 'build', platformTag(), 'naude'));
});

test('seaBin is seaOut plus the platform exe suffix', () => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const opts = { version: '0.1.3', env: {} };
  assert.strictEqual(seaBin('/r', 'naude', opts), seaOut('/r', 'naude', opts) + suffix);
});

test('seaBin/seaOut honor the base param (not hardcoded)', () => {
  const opts = { version: '0.1.3', env: {} };
  assert.ok(seaOut('/r', 'clode', opts).endsWith(path.join(artifactName({ version: '0.1.3' }), 'clode')));
  assert.ok(seaBin('/r', 'clode', opts).includes('clode'));
});

test('seaOut/seaBin honor CLODE_ASSET_NAME through the opts.env override', () => {
  const opts = { env: { CLODE_ASSET_NAME: 'clode-0.1.3-macos-11.0-arm64' } };
  assert.strictEqual(seaOut('/r', 'naude', opts),
    path.join('/r', 'build', 'clode-0.1.3-macos-11.0-arm64', 'naude'));
});

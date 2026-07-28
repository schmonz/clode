'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../scripts/canonical-name.cjs');

test('canonArch: the x64/x86/ia32 remaps; everything else identity', () => {
  assert.strictEqual(C.canonArch('x64'), 'amd64');
  assert.strictEqual(C.canonArch('x86'), 'i386');
  assert.strictEqual(C.canonArch('ia32'), 'i386');   // Node process.arch remap (host build)
  for (const a of ['amd64', 'arm64', 'i386', 'ppc', 'ppc64le', 'sparc', 'sparc64',
    'm68k', 'mipsel', 'mipseb', 'mips64eb', 'riscv64', 's390x', 'alpha', 'hppa',
    'sh3el', 'loongarch64', 'armv7', 'earmv7hf']) {
    assert.strictEqual(C.canonArch(a), a, `${a} should be already-canonical`);
  }
});

test('canonArch: NetBSD port-name tokens normalize (bash mirror has only the token)', () => {
  assert.strictEqual(C.canonArch('macppc'), 'ppc');
  assert.strictEqual(C.canonArch('pmax'), 'mipsel');
  assert.strictEqual(C.canonArch('sgimips'), 'mipseb');
});

test('canonArch: native/guest spellings normalize too', () => {
  assert.strictEqual(C.canonArch('x86_64'), 'amd64');
  assert.strictEqual(C.canonArch('aarch64'), 'arm64');
  assert.strictEqual(C.canonArch('powerpc'), 'ppc');
});

test('the NetBSD port legs: token arch is a PORT name, canonicalized by targetName/tagFor', () => {
  assert.strictEqual(C.targetName('netbsd-macppc'), 'netbsd-ppc');
  assert.strictEqual(C.tagFor('netbsd-pmax', '10.1'), 'netbsd-10.1-mipsel');
  assert.strictEqual(C.engineName('tjs', 'netbsd-sgimips', '26.6.0-1a230d3'), 'tjs-netbsd-mipseb-26.6.0-1a230d3');
});

test('canonOs: only darwin -> macos', () => {
  assert.strictEqual(C.canonOs('darwin'), 'macos');
  for (const o of ['linux', 'windows', 'netbsd', 'freebsd', 'openbsd', 'dragonflybsd',
    'omnios', 'openindiana', 'solaris', 'midnightbsd', 'haiku']) {
    assert.strictEqual(C.canonOs(o), o);
  }
});

test('splitLeg: 2-part, 3-part libc', () => {
  assert.deepStrictEqual(C.splitLeg('netbsd-amd64'), { os: 'netbsd', arch: 'amd64', libc: null });
  assert.deepStrictEqual(C.splitLeg('darwin-arm64'), { os: 'darwin', arch: 'arm64', libc: null });
  assert.deepStrictEqual(C.splitLeg('linux-x64-musl'), { os: 'linux', arch: 'x64', libc: 'musl' });
  assert.deepStrictEqual(C.splitLeg('linux-x64-glibc'), { os: 'linux', arch: 'x64', libc: 'glibc' });
});

test('assetName: floored is dashed <os>-<floor>-<arch>; the arch/os collisions resolve', () => {
  assert.strictEqual(C.assetName('darwin-arm64', '0.1.2', '11.0'), 'clode-0.1.2-macos-11.0-arm64');
  assert.strictEqual(C.assetName('darwin-x64', '0.1.2', '10.6'), 'clode-0.1.2-macos-10.6-amd64');
  assert.strictEqual(C.assetName('darwin-x86', '0.1.2', '10.4'), 'clode-0.1.2-macos-10.4-i386');
  assert.strictEqual(C.assetName('netbsd-amd64', '0.1.2', '10.1'), 'clode-0.1.2-netbsd-10.1-amd64');
  assert.strictEqual(C.assetName('netbsd-sparc', '0.1.2', '10.1'), 'clode-0.1.2-netbsd-10.1-sparc');
  assert.strictEqual(C.assetName('haiku-x64', '0.1.2', 'r1beta5'), 'clode-0.1.2-haiku-r1beta5-amd64');
  assert.strictEqual(C.assetName('omnios-amd64', '0.1.2', 'r151056'), 'clode-0.1.2-omnios-r151056-amd64');
});

test('assetName: bare (no floor) keeps a libc suffix; canonicalizes the mid arch', () => {
  assert.strictEqual(C.assetName('windows-arm64', '0.1.2', undefined), 'clode-0.1.2-windows-arm64');
  assert.strictEqual(C.assetName('linux-x64-musl', '0.1.2', ''), 'clode-0.1.2-linux-amd64-musl');
  assert.strictEqual(C.assetName('linux-arm64-musl', '0.1.2', undefined), 'clode-0.1.2-linux-arm64-musl');
});

test('targetName: canonical <os>-<arch>, libc dropped', () => {
  assert.strictEqual(C.targetName('linux-x64-musl'), 'linux-amd64');
  assert.strictEqual(C.targetName('darwin-arm64'), 'macos-arm64');
  assert.strictEqual(C.targetName('netbsd-sparc'), 'netbsd-sparc');
});

test('engineName: <engine>-<os>-<arch>-<pin>', () => {
  assert.strictEqual(C.engineName('tjs', 'darwin-arm64', '26.6.0-1a230d3'), 'tjs-macos-arm64-26.6.0-1a230d3');
  assert.strictEqual(C.engineName('tjs', 'linux-x64-musl', '26.6.0-1a230d3'), 'tjs-linux-amd64-26.6.0-1a230d3');
  assert.strictEqual(C.engineName('node', 'darwin-arm64', '24.18.0'), 'node-macos-arm64-24.18.0');
});

test('the download-name == list-targets-tag invariant: assetName == clode-<v>-<tagFor>', () => {
  for (const [leg, floor] of [['darwin-arm64', '11.0'], ['netbsd-amd64', '10.1'],
    ['windows-arm64', ''], ['linux-x64-musl', '']]) {
    assert.strictEqual(C.assetName(leg, '9.9.9', floor), `clode-9.9.9-${C.tagFor(leg, floor)}`);
  }
});

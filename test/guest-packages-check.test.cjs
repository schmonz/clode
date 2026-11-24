'use strict';
// Pure-core rows for scripts/guest-packages-check.mjs. FIXTURES ONLY: no network here (the live
// catalog sweep runs in upstream-drift.yml's `guest-packages` job).
//
// THE REPRODUCTION: FreeBSD 15.x quarterly dropped the `cmake` metapackage in favour of
// `cmake-core`; ci run 45354661143's freebsd-amd64 leg died after a 15-minute VM boot. The
// first row builds that catalog (cmake-core, no cmake) and proves the checker is RED on `cmake`
// and green on `cmake-core`: a checker that cannot go red is not a ratchet.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

let m;
test.before(async () => { m = await import('../scripts/guest-packages-check.mjs'); });

// A one-file ustar archive, the shape of FreeBSD's packagesite.pkg (before compression).
function tarOf(name, text) {
  const data = Buffer.from(text);
  const h = Buffer.alloc(512);
  h.write(name, 0, 'latin1');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);                              // checksum placeholder
  h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024)]);
}
const pkgsite = (...pkgs) => pkgs.map(([name, origin]) => JSON.stringify({ name, origin, version: '1' })).join('\n') + '\n';

const FREEBSD15 = pkgsite(['cmake-core', 'devel/cmake-core'], ['gmake', 'devel/gmake'], ['node', 'www/node'],
  ['git', 'devel/git'], ['bash', 'shells/bash']);
const LEG_FB15 = { leg: 'freebsd-amd64', 'guest-platform': 'freebsd', 'guest-version': '15.1',
  'guest-packages': 'cmake gmake node git bash' };

test('FreeBSD 15 reproduction: a catalog with cmake-core and no cmake flags `cmake` (proof of red)', () => {
  const cat = m.parsePkgsite(m.decompress(zlib.zstdCompressSync(tarOf('packagesite.yaml', FREEBSD15))));
  const f = m.checkPackages({ leg: 'freebsd-amd64', tiers: ['ci'], style: 'pkg', label: 'FreeBSD:15:amd64',
    catalog: cat, packages: m.splitPackages(LEG_FB15) });
  const bad = f.filter((x) => x.status === 'missing');
  assert.deepStrictEqual(bad.map((x) => x.name), ['cmake']);
  assert.ok(bad[0].suggestions.includes('cmake-core'), 'names the package the human wants');
  // and the fixed manifest line is green
  const g = m.checkPackages({ leg: 'freebsd-amd64', tiers: ['ci'], style: 'pkg', label: 'x', catalog: cat,
    packages: 'cmake-core gmake node git bash'.split(' ') });
  assert.ok(g.every((x) => x.status === 'ok'));
});

test('the real manifest line for freebsd is green against the FreeBSD 15 shape (and red if cmake returns to it)', () => {
  const legs = m.targets().filter((t) => t.leg['guest-platform'] === 'freebsd');
  assert.ok(legs.length >= 2, 'freebsd amd64+arm64 are in the manifest');
  const cat = m.parsePkgsite(tarOf('packagesite.yaml', FREEBSD15));
  for (const { leg } of legs) {
    const f = m.checkPackages({ leg: leg.leg, tiers: [], style: 'pkg', label: '', catalog: cat,
      packages: m.splitPackages(leg) });
    assert.deepStrictEqual(f.filter((x) => x.status === 'missing'), [], `${leg.leg} resolves`);
  }
});

test('pkg: an origin resolves too (pkg install devel/cmake-core)', () => {
  const cat = m.parsePkgsite(tarOf('packagesite.yaml', FREEBSD15));
  assert.strictEqual(m.resolve('pkg', cat, 'devel/cmake-core'), 'devel/cmake-core');
  assert.strictEqual(m.resolve('pkg', cat, 'cmake'), null);
});

test('pkgsrc pkg_summary: PKGBASE (or PKGNAME minus version) resolves; a lookalike does not', () => {
  const text = 'PKGNAME=cmake-3.31.1nb2\nPKGBASE=cmake\nCOMMENT=x\n\n'
    + 'PKGNAME=git-base-2.47.0\nCOMMENT=y\n\n'
    + 'PKGNAME=nodejs-24.17.0\nPROVIDES=/usr/pkg/lib/libnode.so\n\n';
  const cat = m.parsePkgSummary(text);
  for (const n of ['cmake', 'git-base', 'nodejs']) assert.ok(m.resolve('pkgin', cat, n), n);
  assert.strictEqual(m.resolve('pkgin', cat, 'git'), null, 'git is not git-base');
  assert.strictEqual(m.resolve('pkgin', cat, 'nodejs-24.17.0'), null, 'a PKGNAME with version is not a base');
});

test('OpenBSD index.txt: stems, including the vN suffix and a flavor', () => {
  const ls = (f) => `-rw-r--r--  1 0  0     3434035 Apr 25 13:24:36 2026 ${f}`;
  const cat = m.parseOpenbsdIndex([ls('bash-5.3.9.tgz'), ls('cmake-4.2.3v1.tgz'), ls('node-22.22.2v0.tgz'),
    ls('gmake-4.4.1p0.tgz'), ls('git-2.51.0-no_x11.tgz')].join('\n'));
  for (const n of ['bash', 'cmake', 'node', 'gmake', 'git']) assert.ok(m.resolve('openbsd', cat, n), n);
  assert.strictEqual(m.resolve('openbsd', cat, 'cmake-core'), null);
});

test('IPS: full name or trailing components, across publishers; _FEATURE/_SIGNATURE are not packages', () => {
  const core = JSON.stringify({ _FEATURE: ['x'], omnios: { 'developer/gcc14': [{ version: '1' }], 'shell/bash': [{}] }, _SIGNATURE: { a: 'b' } });
  const extra = JSON.stringify({ 'extra.omnios': { 'ooce/developer/cmake': [{}], 'ooce/runtime/node-22': [{}] } });
  const cat = m.merge([m.parseIpsCatalog(core), m.parseIpsCatalog(extra)]);
  assert.ok(m.resolve('ips', cat, 'ooce/developer/cmake'));
  assert.ok(m.resolve('ips', cat, 'developer/cmake'), 'trailing path components match');
  assert.ok(m.resolve('ips', cat, 'cmake'));
  assert.strictEqual(m.resolve('ips', cat, 'developer/gcc13'), null);
  assert.strictEqual(m.resolve('ips', cat, '_FEATURE'), null);
  assert.strictEqual(m.resolve('ips', cat, 'make'), null, 'components, not substrings');
});

test('planLeg maps each platform to the exact catalog the guest reads', () => {
  const p = (o) => m.planLeg({ 'guest-packages': 'a', ...o });
  assert.deepStrictEqual(p({ 'guest-platform': 'freebsd', 'guest-version': '15.1' }).urls,
    [['https://pkg.freebsd.org/FreeBSD:15:amd64/quarterly/packagesite.pkg']]);
  assert.deepStrictEqual(p({ 'guest-platform': 'freebsd', 'guest-version': '14.4', 'guest-arch': 'arm64' }).urls,
    [['https://pkg.freebsd.org/FreeBSD:14:aarch64/quarterly/packagesite.pkg']]);
  assert.deepStrictEqual(p({ 'guest-platform': 'dragonflybsd', 'guest-version': '6.4.2' }).urls,
    [['https://mirror-master.dragonflybsd.org/dports/dragonfly:6.4:x86:64/LATEST/packagesite.pkg']]);
  assert.match(p({ 'guest-platform': 'netbsd', 'guest-version': '10.1', 'guest-arch': 'arm64' }).urls[0][0],
    /NetBSD\/aarch64\/10\.1\/All\/pkg_summary\.gz$/);
  assert.match(p({ 'guest-platform': 'openbsd', 'guest-version': '7.9' }).urls[0][0], /OpenBSD\/7\.9\/packages\/amd64\/index\.txt$/);
  assert.deepStrictEqual(p({ 'guest-platform': 'omnios', 'guest-version': 'r151058' }).urls.map((u) => u[0]),
    ['https://pkg.omnios.org/r151058/core/catalog/1/catalog.base.C', 'https://pkg.omnios.org/r151058/extra/catalog/1/catalog.base.C']);
});

test('a platform with no readable catalog is UNCHECKED with a reason, never a pass; unknown platforms too', () => {
  for (const pl of ['solaris', 'haiku', 'midnightbsd', 'some-new-os']) {
    const r = m.planLeg({ 'guest-platform': pl, 'guest-version': '1', 'guest-packages': 'a b' });
    assert.strictEqual(r.kind, 'unchecked', pl);
    assert.ok(r.reason.length > 20, `${pl} states why`);
  }
  assert.strictEqual(m.planLeg({ 'guest-platform': 'qemu-netbsd-sparc', 'guest-version': '10.1' }).kind, 'none');
});

test('every VM leg with guest-packages in every tier is either checked or UNCHECKED (none falls through)', () => {
  const ts = m.targets();
  assert.ok(ts.length > 8);
  for (const { leg } of ts) {
    const r = m.planLeg(leg);
    assert.ok(['check', 'unchecked', 'none'].includes(r.kind), leg.leg);
  }
  // both tiers' versions are covered: the ci tier rides a newer FreeBSD than the release floor
  const fbUrls = ts.filter((t) => t.leg['guest-platform'] === 'freebsd' && t.leg.leg === 'freebsd-amd64')
    .map((t) => m.planLeg(t.leg).label);
  assert.deepStrictEqual([...new Set(fbUrls)].sort(), ['FreeBSD:14:amd64', 'FreeBSD:15:amd64']);
});

test('decompress sniffs zstd/gzip/plain; xz without a host tool is Unreadable (UNCHECKED), not a crash', () => {
  const t = Buffer.from('hello');
  assert.strictEqual(m.decompress(zlib.zstdCompressSync(t)).toString(), 'hello');
  assert.strictEqual(m.decompress(zlib.gzipSync(t)).toString(), 'hello');
  assert.strictEqual(m.decompress(t).toString(), 'hello');
  const xzMagic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]);
  assert.throws(() => m.decompress(xzMagic, { xz: () => { throw new m.Unreadable('no xz'); } }), m.Unreadable);
});

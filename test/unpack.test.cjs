'use strict';
// libexec/unpack.cjs: the one gunzip, the in-process tar and zip readers, the extraction that
// writes their entries (modes, symlinks, refusals), and the shared fetch -> verify -> extract.
// Fixtures are built in JS: tar by scripts/tar-pack.cjs (the packer naude's deps.tar comes from),
// zip by test/archive-fixtures.cjs, and the GNU long-name and ustar-prefix headers by hand below,
// since tar-pack writes neither. Where a host tar exists, one row also reads what IT writes, and
// one row runs the extraction under the engine (tjs: node-shim's zlib over the engine's miniz).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const helper = require('./node-shim-helper.cjs');
const unpack = require('../libexec/unpack.cjs');
const { packTar } = require('../scripts/tar-pack.cjs');
const { makeZip } = require('./archive-fixtures.cjs');

const REPO = path.resolve(__dirname, '..');
const POSIX = process.platform !== 'win32';   // modes and symlinks are POSIX facts
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `clode-unpack-${tag}-`));

// A tree with what the real archives carry: an executable, a plain file, a relative symlink, a
// name longer than ustar's 100 bytes (pax path), a symlink target longer than 100 (pax linkpath),
// an empty directory, and a non-ASCII name.
const LONG = `pkg/${'d'.repeat(60)}/${'e'.repeat(60)}/file.js`;
function sampleTree() {
  const root = tmp('src');
  const w = (rel, data, mode) => {
    const p = path.join(root, 'top', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    if (mode !== undefined) fs.chmodSync(p, mode);
  };
  w('bin/tool', '#!/bin/sh\necho hi\n', 0o755);
  w('lib/data.bin', Buffer.from([0, 1, 2, 255, 254, 0]));
  w(LONG, '// deep');
  w('caf\u00e9.txt', 'accent');
  fs.mkdirSync(path.join(root, 'top', 'empty'), { recursive: true });
  if (POSIX) {
    fs.symlinkSync('../lib/data.bin', path.join(root, 'top', 'bin', 'link'));
    fs.symlinkSync(`../${LONG}`, path.join(root, 'top', 'bin', 'longlink'));
  }
  return root;
}

// Every path under dir: [rel, kind, mode, content-or-target].
function snapshot(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const p = path.join(dir, r);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push([r, 'l', 0, fs.readlinkSync(p)]);
      else if (st.isDirectory()) { out.push([r, 'd', POSIX ? st.mode & 0o777 : 0, '']); walk(r); }
      else out.push([r, 'f', POSIX ? st.mode & 0o777 : 0, fs.readFileSync(p).toString('hex')]);
    }
  };
  walk('');
  return out;
}

// ---- gunzip -------------------------------------------------------------------------------------

// Every decompression row runs under BOTH codecs (libexec/unpack.cjs's seam): node has node:zlib and the WHATWG
// DecompressionStream, so the stream codec the bootstrap engine uses is exercised here too, not only under an engine.
const CODECS = ['zlib', 'stream'];
async function withCodec(name, fn) {
  const was = unpack.useCodec(name);
  try { return await fn(); } finally { unpack.useCodec(was); }
}

for (const c of CODECS) {
  test(`gunzip (${c}): binary-exact over a size like an engine template`, () => withCodec(c, async () => {
    const original = Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7919) & 0xff));
    assert.ok(Buffer.from(await unpack.gunzip(zlib.gzipSync(original))).equals(original));
    assert.strictEqual(Buffer.from(await unpack.gunzip(zlib.gzipSync('clode'))).toString(), 'clode');
  }));

  test(`gunzip (${c}): a corrupt or truncated stream rejects, it never returns short bytes`, () => withCodec(c, async () => {
    const gz = zlib.gzipSync(Buffer.from(Array.from({ length: 10000 }, (_, i) => (i * 31) & 0xff)));
    await assert.rejects(async () => unpack.gunzip(gz.subarray(0, gz.length - 12)));
    // only the trailer cut short: the engine's DecompressionStream accepts that in silence (measured on the bootstrap
    // engine, 2026-11-27), so the stream codec checks ISIZE itself
    await assert.rejects(async () => unpack.gunzip(gz.subarray(0, gz.length - 4)));
    const crcBad = Buffer.from(gz); crcBad[crcBad.length - 6] ^= 0xff;
    await assert.rejects(async () => unpack.gunzip(crcBad));
  }));
}

// ---- tar ----------------------------------------------------------------------------------------

test('tar round trip: modes, symlinks, pax long names and long link targets, empty dirs, UTF-8', () => {
  const src = sampleTree();
  const out = tmp('out');
  unpack.writeEntries(unpack.readTar(packTar(src, ['top'])), out);
  assert.deepStrictEqual(snapshot(out), snapshot(src));
  if (POSIX) {
    assert.strictEqual(fs.statSync(path.join(out, 'top', 'bin', 'tool')).mode & 0o111, 0o111, 'executable bit kept');
    assert.strictEqual(fs.readlinkSync(path.join(out, 'top', 'bin', 'longlink')), `../${LONG}`);
  }
});

test('tar via extractArchive: a .tar.gz, a .tgz and a plain .tar by name', async () => {
  const src = sampleTree();
  const tarBytes = packTar(src, ['top']);
  const dir = tmp('kinds');
  for (const [name, bytes] of [['a.tar.gz', zlib.gzipSync(tarBytes)], ['b.tgz', zlib.gzipSync(tarBytes)], ['c.tar', tarBytes]]) {
    fs.writeFileSync(path.join(dir, name), bytes);
    const out = path.join(dir, `${name}.out`);
    await unpack.extractArchive(path.join(dir, name), out);
    assert.deepStrictEqual(snapshot(out), snapshot(src), name);
  }
  assert.throws(() => unpack.archiveKind('x.tar.xz'), /cannot tell what kind of archive/);
});

// A header by hand: ustar fields at their offsets, checksum computed. magic 'gnu' writes GNU's
// "ustar  \0" (no prefix field), 'posix' POSIX's "ustar\0" "00".
function hdr({ name, size = 0, type = '0', mode = 0o644, linkname = '', prefix = '', magic = 'posix' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0'), 100, 'latin1');
  h.write('0000000', 108, 'latin1'); h.write('0000000', 116, 'latin1');
  h.write(size.toString(8).padStart(11, '0'), 124, 'latin1');
  h.write('00000000000', 136, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  if (magic === 'gnu') h.write('ustar  ', 257, 'latin1');
  else { h.write('ustar', 257, 'latin1'); h.write('00', 263, 'latin1'); h.write(prefix, 345, 155, 'utf8'); }
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0'), 148, 'latin1');
  h[154] = 0;
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const END = Buffer.alloc(1024);

test('tar: GNU long names (L) and long link targets (K), as GNU tar writes them', () => {
  const longName = `gnu/${'n'.repeat(150)}`;
  const longTarget = `${'t'.repeat(130)}/x`;
  const body = Buffer.from('gnu body');
  const tar = Buffer.concat([
    hdr({ name: '././@LongLink', type: 'L', size: longName.length + 1, magic: 'gnu' }), pad(Buffer.from(`${longName}\0`)),
    hdr({ name: longName.slice(0, 100), size: body.length, mode: 0o755, magic: 'gnu' }), pad(body),
    hdr({ name: '././@LongLink', type: 'K', size: longTarget.length, magic: 'gnu' }), pad(Buffer.from(longTarget)),
    hdr({ name: 'gnu/lnk', type: '2', linkname: longTarget.slice(0, 100), magic: 'gnu' }),
    END,
  ]);
  const entries = unpack.readTar(tar);
  assert.deepStrictEqual(entries.map((e) => [e.name, e.type, e.mode]), [[longName, 'file', 0o755], ['gnu/lnk', 'symlink', 0o644]]);
  assert.strictEqual(Buffer.from(entries[0].data).toString(), 'gnu body');
  assert.strictEqual(entries[1].linkname, longTarget);
});

test('tar: the ustar prefix field joins the name; a hard link is a copy of the file it names', () => {
  const body = Buffer.from('prefixed');
  const tar = Buffer.concat([
    hdr({ name: 'leaf.txt', prefix: 'some/prefix', size: body.length }), pad(body),
    hdr({ name: 'hard.txt', type: '1', linkname: 'some/prefix/leaf.txt' }),
    END,
  ]);
  const out = tmp('prefix');
  unpack.writeEntries(unpack.readTar(tar), out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'some', 'prefix', 'leaf.txt'), 'utf8'), 'prefixed');
  assert.strictEqual(fs.readFileSync(path.join(out, 'hard.txt'), 'utf8'), 'prefixed');
});

test('tar: refusals by name — bad checksum, truncation, a device node', () => {
  const good = Buffer.concat([hdr({ name: 'a', size: 3 }), pad(Buffer.from('abc')), END]);
  const bad = Buffer.from(good); bad[0] ^= 1;
  assert.throws(() => unpack.readTar(bad), /checksum mismatch/);
  assert.throws(() => unpack.readTar(good.subarray(0, 513)), /truncated/);
  assert.throws(() => unpack.readTar(Buffer.concat([hdr({ name: 'dev', type: '3' }), END])), /type '3'/);
});

test('tar: what a host tar writes reads back the same (when the host has one)', (t) => {
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) { t.skip('no host tar'); return; }
  const src = sampleTree();
  const made = spawnSync('tar', ['-cf', '-', 'top'], { cwd: src, maxBuffer: 1 << 28, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.strictEqual(made.status, 0, String(made.stderr));
  const out = tmp('host');
  unpack.writeEntries(unpack.readTar(made.stdout), out);
  assert.deepStrictEqual(snapshot(out), snapshot(src), r.stdout.split('\n')[0]);
});

// ---- zip ----------------------------------------------------------------------------------------

test('zip (unix-made): stored and deflated files, the executable bit, a symlink, a directory', () => {
  const zip = makeZip([
    { name: 'z/', type: 'dir' },
    { name: 'z/run', data: '#!/bin/sh\n', mode: 0o755 },
    { name: 'z/plain.txt', data: 'x'.repeat(5000), method: 8 },
    { name: 'z/stored.txt', data: 'stored', method: 0 },
    { name: 'z/link', type: 'symlink', linkname: 'plain.txt' },
  ]);
  const out = tmp('zip');
  unpack.writeEntries(unpack.readZip(zip), out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'z', 'plain.txt'), 'utf8'), 'x'.repeat(5000));
  assert.strictEqual(fs.readFileSync(path.join(out, 'z', 'stored.txt'), 'utf8'), 'stored');
  if (POSIX) {
    assert.strictEqual(fs.statSync(path.join(out, 'z', 'run')).mode & 0o111, 0o111);
    assert.strictEqual(fs.readlinkSync(path.join(out, 'z', 'link')), 'plain.txt');
  }
});

test('zip (DOS-made, like the nodejs.org and rcodesign Windows zips): files land with the default mode', () => {
  const out = tmp('doszip');
  unpack.writeEntries(unpack.readZip(makeZip([{ name: 'w/node.exe', data: 'MZ' }, { name: 'w/sub/', type: 'dir' }], { unix: false })), out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'w', 'node.exe'), 'utf8'), 'MZ');
  assert.ok(fs.statSync(path.join(out, 'w', 'sub')).isDirectory());
  if (POSIX) assert.strictEqual(fs.statSync(path.join(out, 'w', 'node.exe')).mode & 0o111, 0, 'no mode recorded, so not executable');
});

test('zip64: the end record pointing at a zip64 end record is followed', () => {
  const zip = makeZip([{ name: 'big/a', data: 'sixty-four' }]);
  const eocdAt = zip.length - 22;
  const cdSize = zip.readUInt32LE(eocdAt + 12), cdOff = zip.readUInt32LE(eocdAt + 16);
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0); z64.writeBigUInt64LE(44n, 4); z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(1n, 24); z64.writeBigUInt64LE(1n, 32); z64.writeBigUInt64LE(BigInt(cdSize), 40); z64.writeBigUInt64LE(BigInt(cdOff), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(eocdAt), 8); loc.writeUInt32LE(1, 16);
  const eocd = Buffer.from(zip.subarray(eocdAt));
  eocd.writeUInt16LE(0xffff, 8); eocd.writeUInt16LE(0xffff, 10); eocd.writeUInt32LE(0xffffffff, 16);
  const z = Buffer.concat([zip.subarray(0, eocdAt), z64, loc, eocd]);
  const [e] = unpack.readZip(z);
  assert.strictEqual(e.name, 'big/a');
  assert.strictEqual(Buffer.from(e.data).toString(), 'sixty-four');
});

test('zip: refusals by name — a failed CRC, encryption, an unknown method, not a zip at all', () => {
  const zip = makeZip([{ name: 'a', data: 'hello hello hello', method: 0 }]);
  const crcBad = Buffer.from(zip); crcBad[30 + 1] ^= 0xff;  // a byte of the stored data
  assert.throws(() => unpack.readZip(crcBad)[0].data, /CRC-32/);
  const enc = Buffer.from(zip); const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => unpack.readZip(enc), /encrypted/);
  const meth = Buffer.from(zip); meth.writeUInt16LE(14, cd + 10);
  assert.throws(() => unpack.readZip(meth), /compression method 14/);
  assert.throws(() => unpack.readZip(Buffer.from('not a zip at all, just bytes here')), /not a zip/);
});

// The stream codec (an engine without __tjs_zlib_sync: the bootstrap engine) writes the same tree, and its CRC-32 is the
// engine's gzip trailer check, so a corrupt deflated entry is refused there too. writeEntries returns a promise only
// here, where the entries' data are promises.
test('zip (stream codec): the same tree, and a failed CRC refused, for stored and deflated entries', () => withCodec('stream', async () => {
  const entries = [
    { name: 'z/', type: 'dir' },
    { name: 'z/run', data: '#!/bin/sh\n', mode: 0o755 },
    { name: 'z/plain.txt', data: 'x'.repeat(5000), method: 8 },
    { name: 'z/stored.txt', data: 'stored', method: 0 },
    { name: 'z/link', type: 'symlink', linkname: 'plain.txt' },
  ];
  const zip = makeZip(entries);
  const out = tmp('zipstream');
  const pending = unpack.writeEntries(unpack.readZip(zip), out);
  assert.ok(pending && typeof pending.then === 'function', 'under the stream codec a zip extraction is asynchronous');
  assert.strictEqual(await pending, entries.length);
  const ref = tmp('zipref');
  unpack.useCodec('zlib');
  assert.strictEqual(unpack.writeEntries(unpack.readZip(zip), ref), entries.length, 'and synchronous under node:zlib');
  unpack.useCodec('stream');
  assert.deepStrictEqual(snapshot(out), snapshot(ref));
  for (const method of [0, 8]) {
    const z = makeZip([{ name: 'a', data: 'hello hello hello hello hello hello', method }]);
    const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt32LE((z.readUInt32LE(cd + 16) ^ 1) >>> 0, cd + 16);   // the central directory's CRC-32
    await assert.rejects(async () => unpack.readZip(z)[0].data, /CRC-32/, `method ${method}`);
  }
}));

// ---- extraction safety --------------------------------------------------------------------------

test('writeEntries refuses an entry outside the destination: absolute, .., or through a symlink it made', () => {
  const file = (name) => ({ name, type: 'file', mode: 0o644, data: Buffer.from('x') });
  assert.throws(() => unpack.writeEntries([file('/etc/evil')], tmp('abs')), /absolute path/);
  assert.throws(() => unpack.writeEntries([file('C:/evil')], tmp('drive')), /absolute path/);
  assert.throws(() => unpack.writeEntries([file('a/../../evil')], tmp('dotdot')), /'\.\.'/);
  if (POSIX) {
    const outside = tmp('outside');
    const out = tmp('through');
    assert.throws(() => unpack.writeEntries([
      { name: 'esc', type: 'symlink', mode: 0o777, linkname: outside },
      file('esc/planted'),
    ], out), /goes through the symlink/);
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing written through the link');
  }
});

// ---- fetch -> verify -> extract -----------------------------------------------------------------

test('fetchVerifiedArchive: verifies before extracting, hands install the tree, removes its work dir', async () => {
  const tmpRoot = tmp('fva');
  const tgz = zlib.gzipSync(packTar(sampleTree(), ['top']));
  const got = await unpack.fetchVerifiedArchive({
    label: 'test', what: 'thing', tmpRoot,
    asset: { url: 'https://example.invalid/t.tar.gz', sha256: 'abc', filename: 't.tar.gz' },
    download: async (_u, dest) => fs.writeFileSync(dest, tgz),
    verify: async () => 'abc',
    install: (into) => fs.readFileSync(path.join(into, 'top', 'bin', 'tool'), 'utf8'),
  });
  assert.strictEqual(got, '#!/bin/sh\necho hi\n');
  assert.deepStrictEqual(fs.readdirSync(tmpRoot), [], 'the work dir is gone');
  let extracted = false;
  await assert.rejects(unpack.fetchVerifiedArchive({
    label: 'test', what: 'thing', tmpRoot,
    asset: { url: 'u', sha256: 'abc', filename: 't.tar.gz' },
    download: async (_u, dest) => fs.writeFileSync(dest, tgz),
    verify: async () => 'def',
    extract: () => { extracted = true; },
    install: () => {},
  }), /test: pinned thing sha mismatch — refusing to use it \(expected abc, got def\)/);
  assert.strictEqual(extracted, false, 'a mismatched download is never extracted');
  assert.deepStrictEqual(fs.readdirSync(tmpRoot), [], 'the work dir is gone after a refusal too');
});

// ---- under the engine ---------------------------------------------------------------------------

test('under tjs: a .tar.gz and a zip extract to the same tree as under node', async (t) => {
  if (!helper.tjsPath()) { t.skip('no tjs engine (CLODE_TJS)'); return; }
  const src = sampleTree();
  const dir = tmp('tjs');
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), zlib.gzipSync(packTar(src, ['top'])));
  fs.writeFileSync(path.join(dir, 'b.zip'), makeZip([
    { name: 'top/bin/tool', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
    { name: 'top/lib/data.bin', data: Buffer.from([0, 1, 2, 255, 254, 0]) },
    ...(POSIX ? [{ name: 'top/bin/link', type: 'symlink', linkname: '../lib/data.bin' }] : []),
  ]));
  const script = path.join(dir, 'x.cjs');
  fs.writeFileSync(script, `const u = require(${JSON.stringify(path.join(REPO, 'libexec', 'unpack.cjs'))});
(async () => {
  for (const f of ['a.tar.gz', 'b.zip']) await u.extractArchive(${JSON.stringify(dir)} + '/' + f, ${JSON.stringify(dir)} + '/tjs-' + f);
  console.log('ok');
})().catch((e) => { console.log('ERR ' + e.message); process.exitCode = 1; });\n`);
  const [cmd, argv] = helper.engineSpawn(['run', helper.LOADER, script]);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.stdout.trim(), 'ok', r.stderr);
  for (const f of ['a.tar.gz', 'b.zip']) await unpack.extractArchive(path.join(dir, f), path.join(dir, `node-${f}`));
  assert.deepStrictEqual(snapshot(path.join(dir, 'tjs-a.tar.gz')), snapshot(src));
  assert.deepStrictEqual(snapshot(path.join(dir, 'tjs-b.zip')), snapshot(path.join(dir, 'node-b.zip')));
});

'use strict';
// archive-fixtures.cjs — build zip archives in JS for the unpack tests, so no fixture needs a
// host `zip` (tar fixtures come from scripts/tar-pack.cjs, the packer naude ships).
//
// makeZip(entries, { unix = true }) -> Buffer. Each entry:
//   { name, data?, mode?, type?: 'file'|'dir'|'symlink', linkname?, method?: 0|8 }
// unix: the archive says it was made on Unix (version-made-by 3) and carries each entry's mode
// and file type in the external attributes, as Info-ZIP and bsdtar write them; unix false is a
// DOS/NTFS-made archive (nodejs.org's and rcodesign's Windows zips), which carries no mode.
const zlib = require('node:zlib');

function makeZip(entries, { unix = true } = {}) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const e of entries) {
    const type = e.type || (e.name.endsWith('/') ? 'dir' : 'file');
    const raw = type === 'symlink' ? Buffer.from(e.linkname) : Buffer.from(e.data || '');
    const method = type === 'dir' ? 0 : (e.method === undefined ? 8 : e.method);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const name = Buffer.from(e.name);
    const ifmt = type === 'symlink' ? 0o120000 : type === 'dir' ? 0o040000 : 0o100000;
    const mode = e.mode === undefined ? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644) : e.mode;
    const ext = unix ? (((ifmt | mode) << 16) >>> 0) + (type === 'dir' ? 0x10 : 0) : (type === 'dir' ? 0x10 : 0x20);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(((unix ? 3 : 0) << 8) | 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(ext, 38); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { makeZip };

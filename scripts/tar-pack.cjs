'use strict';
// tar-pack.cjs — write a tar archive in process: the writing half of libexec/unpack.cjs's reader.
//
// The naude assembler (build-naude.mjs) packs the resolved node_modules into the SEA's deps.tar.
// It ran the host `tar -cf`, the last host tar in a build once every extraction moved in process
// (libexec/unpack.cjs). This writes what that reader reads: POSIX ustar headers, with a pax
// extended header carrying `path` / `linkpath` whenever a name does not fit ustar's 100 bytes
// (no prefix split: one rule, and pax is what bsdtar and GNU tar read alike). Regular files,
// directories and symlinks, with their modes; anything else under the tree is refused by name.
// Entries are in sorted order and carry mtime 0 and no owner, so the same tree packs to the same
// bytes on every host (deps.sig, the sha256 of this archive, keys naude's unpack cache).
//
// A scripts/ sibling, not a libexec module, because the assembler runs as loose scripts under
// the fetched node and carries only scripts/ members (libexec/quaude-blobulate.js's list).
const fs = require('node:fs');
const path = require('node:path');

const BLOCK = 512;
const enc = (s) => Buffer.from(s, 'utf8');

function octal(buf, off, len, v) {
  const s = v.toString(8).padStart(len - 1, '0');
  if (s.length > len - 1) throw new Error(`tar-pack: ${v} does not fit a ${len}-byte header field`);
  buf.write(s, off, len - 1, 'latin1');
  buf[off + len - 1] = 0;
}

function header({ name, mode, size, typeflag, linkname = '' }) {
  const h = Buffer.alloc(BLOCK);
  enc(name).copy(h, 0, 0, 100);
  octal(h, 100, 8, mode & 0o7777);
  octal(h, 108, 8, 0);                  // uid
  octal(h, 116, 8, 0);                  // gid
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);                 // mtime
  h[156] = typeflag.charCodeAt(0);
  enc(linkname).copy(h, 157, 0, 100);
  h.write('ustar\u000000', 257, 8, 'latin1');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148, 8, 'latin1');
  return h;
}

function padded(data) {
  const rem = data.length % BLOCK;
  return rem ? [data, Buffer.alloc(BLOCK - rem)] : [data];
}

// One pax record: "<len> <key>=<value>\n", len counting itself.
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function entryBlocks(e) {
  const out = [];
  const pax = [];
  if (Buffer.byteLength(e.name) > 100) pax.push(paxRecord('path', e.name));
  if (e.linkname && Buffer.byteLength(e.linkname) > 100) pax.push(paxRecord('linkpath', e.linkname));
  if (pax.length) {
    const data = enc(pax.join(''));
    out.push(header({ name: 'PaxHeader', mode: 0o644, size: data.length, typeflag: 'x' }), ...padded(data));
  }
  out.push(header(e));
  if (e.data && e.data.length) out.push(...padded(e.data));
  return out;
}

// packTar(root, names) -> Buffer. Each name is a path relative to root, packed with everything
// under it.
function packTar(root, names) {
  const blocks = [];
  const walk = (rel) => {
    const abs = path.join(root, ...rel.split('/'));
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      blocks.push(...entryBlocks({ name: rel, mode: 0o777, size: 0, typeflag: '2', linkname: fs.readlinkSync(abs) }));
    } else if (st.isDirectory()) {
      blocks.push(...entryBlocks({ name: `${rel}/`, mode: st.mode, size: 0, typeflag: '5' }));
      for (const child of fs.readdirSync(abs).sort()) walk(`${rel}/${child}`);
    } else if (st.isFile()) {
      const data = fs.readFileSync(abs);
      blocks.push(...entryBlocks({ name: rel, mode: st.mode, size: data.length, typeflag: '0', data }));
    } else {
      throw new Error(`tar-pack: ${abs} is neither a file, a directory nor a symlink; refusing to pack it`);
    }
  };
  for (const n of [...names].sort()) walk(n.split(path.sep).join('/'));
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

module.exports = { packTar };

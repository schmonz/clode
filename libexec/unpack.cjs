'use strict';
// unpack.cjs — the ONE way clode unpacks a download: gunzip, a tar reader, a zip reader, the
// extraction that writes their entries to disk, and the fetch -> verify -> extract sequence the
// pinned-download seams share (clode-node.cjs's Node, clode-rcodesign.cjs's rcodesign).
//
// WHY IN PROCESS, and why this file. Unpacking used to be three host tools (tar, gzip, unzip),
// each found and KAT-checked by host-provision.cjs, plus a DecompressionStream fallback for gzip,
// and the two pinned-download seams disagreed about .zip: clode-node ran `unzip`, which Windows
// does not ship, and clode-rcodesign ran `tar -xf`, which GNU tar cannot do
// (docs/superpowers/findings/2026-11-27-latent-capabilities-audit.md, D3 and rank 3). Every
// compressed byte now goes through ONE decompression seam (CODECS, below): node:zlib, synchronous,
// wherever it can answer synchronously (under node, and under tjs on an engine with the engine's
// miniz behind __tjs_zlib_sync, spike/quickjs/patches/txiki-zlib-sync.patch), and the WHATWG
// DecompressionStream, asynchronous, on an engine without it. The second is not a nicety: the
// engine build runs on the pinned BOOTSTRAP engine (scripts/bootstrap-engine.sh, v0.20260831.1),
// which predates that patch, and the cosmo leg extracts its cosmocc zip there (CI run 46018235655:
// "this engine has no __tjs_zlib_sync ... so zlib.crc32 cannot answer"). So extraction is async
// (extractArchive and gunzip return promises), while the readers and the writer stay synchronous
// wherever the bytes are: writeEntries returns a promise only when an entry's data is one. The two
// container formats are plain data structures read here: tar is 512-byte headers, and zip is a
// central directory of entries, each stored or raw-deflated.
//
// WHAT IS READ. tar: ustar (with its 155-byte prefix), GNU long names and long link targets
// ('L'/'K'), pax extended headers ('x', and 'g' globals) for path, linkpath and size, GNU
// base-256 sizes, and the entry types regular file, directory, symlink and hard link. That
// covers the archives clode extracts: nodejs.org's release tarballs (pax, symlinks such as
// bin/npm), rcodesign's release tarballs, and naude's deps.tar (bsdtar on macOS, GNU tar
// elsewhere). zip: stored and deflated entries, zip64 sizes and offsets, unix modes and symlinks
// from a unix-made archive's external attributes (nodejs.org's and rcodesign's Windows zips, and
// cosmocc's). Anything else (a device node, a fifo, an encrypted or otherwise compressed zip
// entry) is refused by name, never skipped.
//
// WHAT IS WRITTEN. Every entry lands under the destination or the extraction refuses: an
// absolute name, a `..` segment, or a path through a symlink this same extraction made is a
// refusal (tar's and unzip's own defaults). File modes are the archive's, masked by the umask as
// tar and unzip do for a non-root user, so executable bits survive; symlinks are symlinks; a tar
// hard link is a copy of the file it names (the engine has no link(2)).
const fs = require('node:fs');
const path = require('node:path');

// Names are UTF-8 (pax says so; GNU tar and zip's bit 11 write it). TextDecoder, not Buffer: it is
// the same under node and tjs.
const UTF8 = new TextDecoder('utf-8');
const utf8 = (buf, off, len) => UTF8.decode(buf.subarray(off, off + len));

// ---- decompression: the one seam -----------------------------------------------------------------
// Two codecs, one interface: gunzip(bytes) and inflateRaw(raw, crc, size, name), each returning the
// bytes or a promise of them, and refusing (never returning short or wrong bytes) on a corrupt input.
//   zlib    node:zlib, synchronous: node's own zlib, or node-shim's over the engine's miniz.
//   stream  the WHATWG DecompressionStream, asynchronous: what an engine without __tjs_zlib_sync
//           (the bootstrap engine) has. Its integrity checks are the engine's gzip trailer check:
//           a raw-deflate zip entry is framed as a one-member gzip stream whose trailer carries the
//           central directory's CRC-32 and size, so the engine verifies the CRC natively (a pure-JS
//           CRC-32 measured 16MB/s on the bootstrap engine, 2026-11-27, about 80s for cosmocc). The
//           engine accepts a gzip stream whose trailer is cut short, so gunzip also checks ISIZE.
//           Only a stored zip entry is CRC-checked in JS, and stored entries are small.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32js(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function checkInflated(name, data, crc, size, crcOf) {
  if (data.length !== size) throw new Error(`unpack: zip entry '${name}' inflated to ${data.length} bytes, its header says ${size}`);
  if (crcOf && (crcOf(data) >>> 0) !== crc) throw new Error(`unpack: zip entry '${name}' fails its CRC-32`);
  return data;
}

// Every chunk a DecompressionStream yields for `pieces`, as one Uint8Array. A decode error rejects.
async function decompress(format, pieces) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const writing = (async () => { for (const p of pieces) await writer.write(p); await writer.close(); })();
  writing.catch(() => {});   // its error is the reader's too, and surfaces there or at the await below
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await writing;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

const le32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const GZIP_HEADER = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);   // deflate, no flags, unknown OS

const CODECS = {
  zlib: {
    gunzip: (bytes) => require('node:zlib').gunzipSync(bytes),
    inflateRaw(raw, crc, size, name) {
      const zlib = require('node:zlib');
      return checkInflated(name, zlib.inflateRawSync(raw), crc, size, zlib.crc32);
    },
    crc32: (b) => require('node:zlib').crc32(b),
  },
  stream: {
    async gunzip(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b) throw new Error('unpack: not a gzip stream (no gzip header)');
      const out = await decompress('gzip', [b]);
      const isize = (b[b.length - 4] | (b[b.length - 3] << 8) | (b[b.length - 2] << 16) | (b[b.length - 1] << 24)) >>> 0;
      if (isize !== (out.length >>> 0)) throw new Error(`unpack: gzip stream is truncated or corrupt (it decoded to ${out.length} bytes, its trailer says ${isize} mod 2^32)`);
      return out;
    },
    async inflateRaw(raw, crc, size, name) {
      let data;
      try {
        data = await decompress('gzip', [GZIP_HEADER, raw, le32(crc), le32(size >>> 0)]);
      } catch (e) {
        throw new Error(`unpack: zip entry '${name}' fails to inflate or fails its CRC-32 (${e && e.message ? e.message : e})`);
      }
      return checkInflated(name, data, crc, size, null);
    },
    crc32: crc32js,
  },
};

// node:zlib can answer synchronously under node (no globalThis.tjs) and under tjs on an engine
// with __tjs_zlib_sync. Asked here, by a probe, and never by calling node-shim's zlib: that would
// append a refusal to CLODE_ENGINE_FLOOR_LOG, which build-leg gates the bootstrap engine on.
function defaultCodec() {
  return (typeof globalThis.tjs === 'undefined' || typeof globalThis.__tjs_zlib_sync === 'function') ? 'zlib' : 'stream';
}
let codec = CODECS[defaultCodec()];
// Which codec is in use; with a name, switch to it and return the previous one's. For the tests that
// run the stream path under node, where both exist.
function useCodec(name) {
  const was = Object.keys(CODECS).find((k) => CODECS[k] === codec);
  if (name !== undefined) {
    if (!CODECS[name]) throw new Error(`unpack: no codec '${name}' (one of: ${Object.keys(CODECS).join(', ')})`);
    codec = CODECS[name];
  }
  return was;
}

const isPromise = (v) => v !== null && typeof v === 'object' && typeof v.then === 'function';

// ---- gunzip ------------------------------------------------------------------------------------
async function gunzip(bytes) {
  return codec.gunzip(bytes);
}

// ---- tar ---------------------------------------------------------------------------------------
const BLOCK = 512;

function cstr(buf, off, len) {
  let end = off;
  const stop = off + len;
  while (end < stop && buf[end] !== 0) end++;
  return utf8(buf, off, end - off);
}

// A numeric header field: octal digits (space- or NUL-padded), or GNU's base-256 when the first
// byte's high bit is set (sizes over 8GB, which tar writes that way).
function num(buf, off, len) {
  if (buf[off] & 0x80) {
    let v = buf[off] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
    return v;
  }
  const s = cstr(buf, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`unpack: tar header has a non-octal number field '${s}'`);
  return parseInt(s, 8);
}

function zeroBlock(h) {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false;
  return true;
}

function checksumOk(h) {
  const want = num(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
  return sum === want;
}

// pax records: "<len> <key>=<value>\n", len counting the whole record.
function paxRecords(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(utf8(data, i, sp - i), 10);
    if (!(len > 0) || i + len > data.length) throw new Error('unpack: malformed pax extended header');
    const rec = utf8(data, sp + 1, len - (sp - i) - 2);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// readTar(bytes) -> [{ name, type: 'file'|'dir'|'symlink'|'link', mode, data?, linkname? }]
// The entries' data are views into `bytes` (no copy).
function readTar(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = [];
  let off = 0;
  let globalPax = {};
  let pax = null, longName = null, longLink = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (zeroBlock(h)) break;
    if (!checksumOk(h)) throw new Error(`unpack: tar header checksum mismatch at offset ${off} (not a tar, or corrupt)`);
    const typeflag = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const ext = Object.assign({}, globalPax, pax || {});
    const size = ext.size !== undefined ? Number(ext.size) : num(h, 124, 12);
    off += BLOCK;
    if (off + size > buf.length) throw new Error(`unpack: tar truncated (an entry needs ${size} bytes at offset ${off}, the archive has ${buf.length - off})`);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === 'x') { pax = paxRecords(data); continue; }
    if (typeflag === 'g') { globalPax = Object.assign(globalPax, paxRecords(data)); continue; }
    if (typeflag === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (typeflag === 'K') { longLink = cstr(data, 0, data.length); continue; }
    // ustar's prefix field only where the magic is POSIX's "ustar\0"; GNU's "ustar  " keeps
    // other fields there.
    const posix = h[257] === 0x75 && h[262] === 0 && cstr(h, 257, 6) === 'ustar';
    const prefix = posix ? cstr(h, 345, 155) : '';
    const base = cstr(h, 0, 100);
    const name = ext.path !== undefined ? ext.path : longName !== null ? longName : (prefix ? `${prefix}/${base}` : base);
    const linkname = ext.linkpath !== undefined ? ext.linkpath : longLink !== null ? longLink : cstr(h, 157, 100);
    const mode = num(h, 100, 8) & 0o7777;
    pax = null; longName = null; longLink = null;
    if (typeflag === '0' || typeflag === '7') entries.push({ name, type: 'file', mode, data });
    else if (typeflag === '5') entries.push({ name, type: 'dir', mode });
    else if (typeflag === '2') entries.push({ name, type: 'symlink', mode, linkname });
    else if (typeflag === '1') entries.push({ name, type: 'link', mode, linkname });
    else throw new Error(`unpack: tar entry '${name}' has type '${typeflag}', which clode does not extract (only files, directories, symlinks and hard links)`);
  }
  return entries;
}

// ---- zip ---------------------------------------------------------------------------------------
const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  throw new Error('unpack: not a zip archive (no end-of-central-directory record)');
}

// readZip(bytes) -> the same entry shape as readTar. Each file's data is inflated (or sliced, for
// a stored entry) and its CRC-32 checked when `data` is read; a symlink's target, when `linkname`
// is read. Under the stream codec either is a promise.
function readZip(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const eocd = findEocd(buf);
  let count = u16(buf, eocd + 10);
  let cdOff = u32(buf, eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(buf, loc) !== 0x07064b50) throw new Error('unpack: zip64 archive without a zip64 locator');
    const z64 = u64(buf, loc + 8);
    if (u32(buf, z64) !== 0x06064b50) throw new Error('unpack: zip64 end-of-central-directory record not found');
    count = u64(buf, z64 + 32);
    cdOff = u64(buf, z64 + 48);
  }
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error(`unpack: zip central directory is corrupt at offset ${p}`);
    const madeBy = u16(buf, p + 4) >> 8;
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    let csize = u32(buf, p + 20), usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), commentLen = u16(buf, p + 32);
    const extAttr = u32(buf, p + 38);
    let localOff = u32(buf, p + 42);
    const name = utf8(buf, p + 46, nameLen);
    // zip64 extended information: only the fields whose 32-bit slot is saturated, in this order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(buf, e), len = u16(buf, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(buf, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(buf, q); q += 8; }
        if (localOff === 0xffffffff) { localOff = u64(buf, q); q += 8; }
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    if (flags & 0x1) throw new Error(`unpack: zip entry '${name}' is encrypted`);
    const unixMode = madeBy === 3 ? (extAttr >>> 16) : 0;
    const isDir = name.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR || (!unixMode && (extAttr & 0x10));
    if (isDir) { entries.push({ name, type: 'dir', mode: (unixMode & 0o7777) || 0o755 }); continue; }
    if (u32(buf, localOff) !== 0x04034b50) throw new Error(`unpack: zip local header for '${name}' not found`);
    const start = localOff + 30 + u16(buf, localOff + 26) + u16(buf, localOff + 28);
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`unpack: zip entry '${name}' uses compression method ${method} (only stored and deflate are read)`);
    const inflate = () => (method === 0 ? checkInflated(name, raw, crc, usize, codec.crc32) : codec.inflateRaw(raw, crc, usize, name));
    if ((unixMode & S_IFMT) === S_IFLNK) {
      const text = (t) => utf8(t, 0, t.length);
      entries.push({ name, type: 'symlink', mode: unixMode & 0o7777, get linkname() { const t = inflate(); return isPromise(t) ? t.then(text) : text(t); } });
    } else {
      // A DOS/NTFS-made entry carries no mode: unzip's default, 0666 under the umask. The data is
      // inflated when it is read, so an extraction holds one entry's bytes at a time, not the
      // whole archive's (cosmocc's 441MB zip inflates to well over a gigabyte).
      entries.push({ name, type: 'file', mode: unixMode ? unixMode & 0o7777 : 0o666, get data() { return inflate(); } });
    }
  }
  return entries;
}

// ---- extraction --------------------------------------------------------------------------------
// An archive name, as a relative path under the destination, or a refusal.
function safeRelative(name) {
  const parts = name.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (/^([A-Za-z]:|\/)/.test(name) || name.startsWith('\\')) {
    throw new Error(`unpack: archive entry '${name}' is an absolute path; refusing to extract outside the destination`);
  }
  if (parts.includes('..')) throw new Error(`unpack: archive entry '${name}' climbs out with '..'; refusing to extract it`);
  return parts;
}

function umask() {
  try { return typeof process.umask === 'function' ? process.umask() : 0o022; } catch { return 0o022; }
}

// Write entries under destDir. Returns the number written, or, when an entry's data or link target
// is a promise (a zip under the stream codec), a promise of it: the same writer either way, each
// entry written in order, one entry's bytes held at a time.
function writeEntries(entries, destDir) {
  const w = entryWriter(destDir);
  const payload = (e) => (e.type === 'file' ? e.data : e.type === 'symlink' ? e.linkname : undefined);
  let i = 0;
  const run = () => {
    while (i < entries.length) {
      const e = entries[i++];
      const v = payload(e);
      if (isPromise(v)) return v.then((got) => { w.put(e, got); return run(); });
      w.put(e, v);
    }
    w.finish();
    return entries.length;
  };
  return run();
}

// The writer's state, one entry at a time: put(entry, payload) where payload is a file's bytes or a
// symlink's target, then finish().
function entryWriter(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const mask = ~umask() & 0o777;
  const links = new Set();      // symlinks this extraction made, as relative paths
  const dirModes = [];
  const copies = [];            // [link, target] Windows could not link (see the symlink case)
  // Directories already made, so each is made once: under tjs a recursive mkdir of a directory
  // that exists costs about as much as writing a small file (measured 2026-11-27, 0.3ms each).
  const made = new Set();
  const mkdirp = (d) => { if (!made.has(d)) { fs.mkdirSync(d, { recursive: true }); made.add(d); } };
  const through = (parts) => {
    for (let i = 1; i < parts.length; i++) {
      if (links.has(parts.slice(0, i).join('/'))) {
        throw new Error(`unpack: archive entry '${parts.join('/')}' goes through the symlink '${parts.slice(0, i).join('/')}' it just made; refusing to extract it`);
      }
    }
  };
  const clear = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* absent, or a directory: tar keeps a directory */ } };
  const put = (e, payload) => {
    const parts = safeRelative(e.name);
    if (parts.length === 0) return;   // "./" itself
    through(parts);
    const rel = parts.join('/');
    const target = path.join(destDir, ...parts);
    if (e.type === 'dir') {
      mkdirp(target);
      dirModes.push([target, e.mode & mask]);
      return;
    }
    mkdirp(path.dirname(target));
    clear(target);
    if (e.type === 'file') {
      fs.writeFileSync(target, payload, { mode: e.mode & 0o777 });
      fs.chmodSync(target, e.mode & mask);
    } else if (e.type === 'symlink') {
      try {
        fs.symlinkSync(payload, target);
      } catch (err) {
        // WINDOWS, a platform fact: making a symlink needs a privilege (or Developer Mode) most
        // accounts lack, and the call fails EPERM. Git for Windows' tar copied the target instead,
        // and so does this, once every entry is down (the target may come later in the archive).
        if (process.platform !== 'win32' || !err || err.code !== 'EPERM') throw err;
        copies.push([target, path.resolve(path.dirname(target), payload)]);
      }
      links.add(rel);
    } else if (e.type === 'link') {
      const from = safeRelative(e.linkname);
      through(from);
      fs.copyFileSync(path.join(destDir, ...from), target);
    }
  };
  const finish = () => {
    for (const [to, from] of copies) {
      if (!path.resolve(from).startsWith(path.resolve(destDir) + path.sep)) {
        throw new Error(`unpack: symlink ${to} points outside the destination (${from}); this Windows account cannot make symlinks and it will not copy from there`);
      }
      fs.cpSync(from, to, { recursive: true });
    }
    // Directory modes last, deepest first: a read-only directory set early would refuse its own
    // contents.
    for (const [d, m] of dirModes.reverse()) { if (m & 0o700) fs.chmodSync(d, m); }
  };
  return { put, finish };
}

// What an archive's name says it is. One table, the only place an extension decides anything.
function archiveKind(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar.gz';
  if (f.endsWith('.tar')) return 'tar';
  if (f.endsWith('.zip')) return 'zip';
  throw new Error(`unpack: cannot tell what kind of archive '${path.basename(file)}' is (expected .tar.gz, .tgz, .tar or .zip)`);
}

// -> a promise of the entries (gunzip may be asynchronous; see the decompression seam).
async function readArchive(bytes, kind) {
  if (kind === 'tar.gz') return readTar(await gunzip(bytes));
  if (kind === 'tar') return readTar(bytes);
  if (kind === 'zip') return readZip(bytes);
  throw new Error(`unpack: unknown archive kind '${kind}'`);
}

// Extract the archive at `file` into destDir. -> a promise of the number of entries written.
async function extractArchive(file, destDir) {
  return writeEntries(await readArchive(fs.readFileSync(file), archiveKind(file)), destDir);
}

// ---- fetch -> verify -> extract ----------------------------------------------------------------
// The sequence every pinned download shares: a private work dir under tmpRoot, the download, the
// sha256 check against the pin (a mismatch refuses, naming both), the extraction into
// <work>/extracted, then the caller's install(extractedInto) moves what it wants into the store.
// The work dir goes away whatever happens. Returns what install returns.
//   label    the caller's name, which starts every message ('clode-node')
//   what     what is pinned, for the mismatch refusal ('node')
//   asset    { url, sha256, filename }
async function fetchVerifiedArchive({ label, what, asset, tmpRoot, download, verify, extract = extractArchive, log = () => {}, install }) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpRoot, 'dl-'));
  const archivePath = path.join(workDir, asset.filename);
  try {
    log(`${label}: downloading ${asset.url}`);
    await download(asset.url, archivePath);
    const actualSha = await verify(archivePath);
    if (actualSha !== asset.sha256) {
      throw new Error(`${label}: pinned ${what} sha mismatch — refusing to use it (expected ${asset.sha256}, got ${actualSha})`);
    }
    const extractedInto = path.join(workDir, 'extracted');
    fs.mkdirSync(extractedInto, { recursive: true });
    await extract(archivePath, extractedInto);
    return await install(extractedInto);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { gunzip, readTar, readZip, writeEntries, archiveKind, readArchive, extractArchive, fetchVerifiedArchive, useCodec };

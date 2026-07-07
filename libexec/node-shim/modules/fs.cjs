'use strict';
// node:fs over the __tjs_fs_sync patch (sync) + tjs native fs (promises).
// M1 surface; Buffer returns upgrade in Task 7 (buffer-lite).
//
// __tjs_fs_sync verified against spike/quickjs/vendor/txiki.js/src/mod_fs_sync.c:
//   - open(path, flags): flags is one of 'r'|'w'|'a'|'r+'|'w+' (strings).
//   - read(fd, len, pos): pos<0 uses read() (advances fd offset); pos>=0
//     uses pread() (does not move fd offset). Returns an ArrayBuffer.
//   - write(fd, ab, pos): ab MUST be an ArrayBuffer (JS_GetArrayBuffer
//     requires the ArrayBuffer class, not a typed-array view) — pos<0
//     uses write() (advances offset), pos>=0 uses pwrite().
//   - stat/lstat/fstat return {size, mode, mtimeMs, kind} where kind is
//     'file'|'dir'|'symlink'|'other'; mtimeMs is whole-second resolution
//     (st_mtime * 1000) — do not compare across independently-created files.
//   - symlink(target, linkpath) — same arg order as POSIX symlink(2) and
//     as node's fs.symlinkSync(target, path).
//   - errors are real Error instances with .code/.errno/.syscall set by the
//     C throw_errno() helper (e.g. ENOENT, EEXIST).
//
// tjs.readFile: probed against the pinned tjs v26.6.0 binary —
//   `build/tjs/tjs eval 'tjs.readFile("/etc/hosts").then(d => console.log(d.constructor.name, d.byteLength))'`
//   -> "Uint8Array 1681" (NOT ArrayBuffer). TextDecoder#decode accepts a
//   Uint8Array directly, so promises.readFile decodes it with no extra copy.
const FSS = globalThis.__tjs_fs_sync;
const path = require('node:path');
const td = new TextDecoder();
const te = new TextEncoder();

const constants = { F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4 };

// latin1/binary decode: 1 byte -> 1 code point (0..255). This is the
// extractor's core representation (extract-claude-js reads the native binary as
// a latin1 string so byte regexes become string regexes). Chunked so a large
// (multi-MB) binary does not blow String.fromCharCode's argument limit.
function latin1Decode(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return s;
}
const isLatin1 = (enc) => enc === 'latin1' || enc === 'binary';

class Stats {
  #kind;
  constructor(raw) { this.size = raw.size; this.mode = raw.mode; this.mtimeMs = raw.mtimeMs; this.#kind = raw.kind; }
  isFile() { return this.#kind === 'file'; }
  isDirectory() { return this.#kind === 'dir'; }
  isSymbolicLink() { return this.#kind === 'symlink'; }
}

function readAll(fd) {
  const size = FSS.fstat(fd).size;
  const out = new Uint8Array(size);
  let got = 0;
  while (got < size) {
    const ab = FSS.read(fd, Math.min(1 << 20, size - got), got);
    if (ab.byteLength === 0) break;
    out.set(new Uint8Array(ab), got); got += ab.byteLength;
  }
  return out.subarray(0, got);
}

function readFileSync(p, opts) {
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const fd = FSS.open(p, 'r');
  try {
    const data = readAll(fd);
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return data;
  } finally { FSS.close(fd); }
}

function writeFileSync(p, data) {
  const bytes = typeof data === 'string' ? te.encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
  const fd = FSS.open(p, 'w');
  try {
    const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    let written = 0;
    while (written < ab.byteLength) written += FSS.write(fd, written === 0 ? ab : ab.slice(written), -1);
  } finally { FSS.close(fd); }
}

function mkdirSync(p, opts) {
  if (opts?.recursive) {
    const parts = path.resolve(p).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      try { FSS.mkdir(cur, 0o777); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    return;
  }
  FSS.mkdir(p, opts?.mode ?? 0o777);
}

function readSync(fd, buf, offset, length, position) {
  const ab = FSS.read(fd, length, position ?? -1);
  const src = new Uint8Array(ab);
  buf.set(src, offset);
  return src.length;
}

const statSync = (p) => new Stats(FSS.stat(p));
const lstatSync = (p) => new Stats(FSS.lstat(p));

const fsMod = {
  constants,
  readFileSync, writeFileSync, mkdirSync, readSync,
  statSync, lstatSync,
  fstatSync: (fd) => new Stats(FSS.fstat(fd)),
  existsSync: (p) => { try { FSS.stat(p); return true; } catch { return false; } },
  realpathSync: (p) => FSS.realpath(p),
  readlinkSync: (p) => FSS.readlink(p),
  readdirSync: (p, opts) => {
    if (opts?.withFileTypes) throw new Error('node-shim: fs.readdirSync withFileTypes not implemented');
    return FSS.readdir(p);
  },
  rmdirSync: (p) => FSS.rmdir(p),
  unlinkSync: (p) => FSS.unlink(p),
  renameSync: (a, b) => FSS.rename(a, b),
  accessSync: (p, m) => FSS.access(p, m ?? constants.F_OK),
  openSync: (p, flags) => FSS.open(p, flags ?? 'r'),
  closeSync: (fd) => FSS.close(fd),
  copyFileSync: (a, b) => writeFileSync(b, readFileSync(a)),
  symlinkSync: (target, p) => FSS.symlink(target, p),
  chmodSync: (p, m) => FSS.chmod(p, m),
};

const promises = {
  readFile: async (p, opts) => {
    const enc = typeof opts === 'string' ? opts : opts?.encoding;
    const data = await tjs.readFile(p); // Uint8Array, verified against pinned tjs v26.6.0
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return data;
  },
  writeFile: async (p, data) => { writeFileSync(p, data); },
  stat: async (p) => statSync(p),
  mkdir: async (p, opts) => mkdirSync(p, opts),
  readdir: async (p) => FSS.readdir(p),
  access: async (p, m) => FSS.access(p, m ?? constants.F_OK),
  realpath: async (p) => FSS.realpath(p),
  rm: async (p, opts) => {
    const l = (() => { try { return lstatSync(p); } catch (e) { if (opts?.force && e.code === 'ENOENT') return null; throw e; } })();
    if (!l) return;
    if (l.isDirectory()) {
      if (!opts?.recursive) return FSS.rmdir(p);
      for (const n of FSS.readdir(p)) await promises.rm(path.join(p, n), opts);
      return FSS.rmdir(p);
    }
    return FSS.unlink(p);
  },
};
fsMod.promises = promises;

const cbWrap = (pfn) => (...args) => {
  const cb = args.pop();
  pfn(...args).then((v) => cb(null, v), (e) => cb(e));
};
fsMod.readFile = cbWrap(promises.readFile);
fsMod.stat = cbWrap(promises.stat);
fsMod.access = cbWrap(promises.access);

module.exports = fsMod;

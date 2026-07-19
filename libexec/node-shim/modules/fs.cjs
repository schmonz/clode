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

// Access-mode + open-flag (O_*) constants. Node's numeric O_* values are
// platform-specific; the shim presents per navigator.platform (see
// process.cjs detectPlatform), so pick the matching table. These feed
// fs.promises.open(path, flags): the bundle's Bash tool opens its log file
// with `O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW` (a numeric bitmask). Without the
// flags every term is undefined -> NaN bitmask, and (before promises.open
// existed) the call threw "not a function". The values must be self-consistent
// with promises.open's bit interpretation below; darwin/linux match the real
// kernel values so a consumer inspecting a specific bit reads node's answer.
const _isDarwin = (() => {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  return /^Mac/.test(np);
})();
const O = _isDarwin
  ? { O_RDONLY: 0x0000, O_WRONLY: 0x0001, O_RDWR: 0x0002, O_CREAT: 0x0200,
      O_EXCL: 0x0800, O_TRUNC: 0x0400, O_APPEND: 0x0008, O_NOFOLLOW: 0x0100,
      O_NONBLOCK: 0x0004, O_SYNC: 0x0080, O_DIRECTORY: 0x100000, O_CLOEXEC: 0x1000000 }
  : { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_EXCL: 0o200,
      O_TRUNC: 0o1000, O_APPEND: 0o2000, O_NOFOLLOW: 0o400000, O_NONBLOCK: 0o4000,
      O_SYNC: 0o4010000, O_DIRECTORY: 0o200000, O_CLOEXEC: 0o2000000 };
const constants = { F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4, ...O };

// Translate an open() flags argument (numeric O_* bitmask OR a node string like
// 'r'/'w'/'a'/'r+'/'w+') into the string flag FSS.open understands. FSS.open
// (mod_fs_sync.c) accepts 'r'|'w'|'a'|'r+'|'w+', each optionally suffixed 'n'
// for O_NONBLOCK; map the numeric bits onto the closest one. O_NOFOLLOW is
// dropped (best-effort; FSS.open has no NOFOLLOW variant — a documented,
// benign divergence for the Bash log file). O_NONBLOCK is NOT droppable: the
// bundle's drainStdin opens /dev/tty O_RDONLY|O_NONBLOCK and readSync()s until
// EAGAIN — a blocking open/read there parks tjs's only thread in kernel read()
// and wedges the whole engine (the /quit freeze). The 'n' suffix needs the
// matching mod_fs_sync.c; an older engine rejects it with a LOUD
// "fs_sync.open: bad flags" TypeError rather than silently blocking.
// Characterized by test/node-shim-fs-nonblock.test.cjs.
function flagsToString(flags) {
  if (typeof flags === 'string') return flags;
  if (typeof flags !== 'number') return 'r';
  const nb = (flags & O.O_NONBLOCK) ? 'n' : '';
  const rw = flags & 0o3; // low 2 bits: RDONLY(0)/WRONLY(1)/RDWR(2)
  // FSS.open supports only 'r'|'w'|'a'|'r+'|'w+' (no 'a+') — collapse onto those.
  if (flags & O.O_APPEND) return 'a' + nb;
  if (flags & O.O_TRUNC) return ((rw === O.O_RDWR) ? 'w+' : 'w') + nb;
  if (flags & O.O_CREAT) return ((rw === O.O_RDWR) ? 'w+' : 'w') + nb;
  if (rw === O.O_RDWR) return 'r+' + nb;
  if (rw === O.O_WRONLY) return 'w' + nb;
  return 'r' + nb;
}

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
// latin1/binary encode: low byte of each code point (mirror of latin1Decode /
// buffer-lite's Buffer.from(,'latin1')).
function latin1Encode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

class Stats {
  #kind;
  constructor(raw) {
    this.size = raw.size;
    this.mode = raw.mode;
    this.#kind = raw.kind;
    // FSS.stat exposes only mtimeMs (second-resolution: st_mtime*1000). Node's
    // Stats carries atime/mtime/ctime/birthtime as both Date and *Ms/*Ns.
    // DIVERGENCE (documented): this build reads only the whole-second mtime, so
    // atime/ctime/birthtime are approximated as mtime, and sub-second precision
    // is not observable (an mtime-precision probe will read "second" resolution).
    // The Date accessors must exist regardless — deps do stat().mtime.getTime().
    const ms = raw.mtimeMs;
    this.mtimeMs = ms; this.atimeMs = ms; this.ctimeMs = ms; this.birthtimeMs = ms;
    this.mtime = new Date(ms); this.atime = new Date(ms);
    this.ctime = new Date(ms); this.birthtime = new Date(ms);
    // Numeric fields Node always provides; not surfaced by FSS.stat → 0 defaults
    // so property reads (e.g. dev/ino identity checks) don't throw.
    this.dev = 0; this.ino = 0; this.nlink = 1; this.uid = 0; this.gid = 0;
    this.rdev = 0; this.blksize = 4096; this.blocks = Math.ceil((raw.size || 0) / 512);
  }
  isFile() { return this.#kind === 'file'; }
  isDirectory() { return this.#kind === 'dir'; }
  isSymbolicLink() { return this.#kind === 'symlink'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return this.#kind === 'char'; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

// fs.Dirent — the shape readdir(withFileTypes) yields. FSS.readdir returns NAMES
// only (probed), so the entry kind comes from an lstat (no symlink follow, like
// node's d_type). `parentPath` is node's field (`path` is the deprecated alias).
class Dirent {
  #kind;
  constructor(name, kind, parentPath) { this.name = name; this.parentPath = parentPath; this.path = parentPath; this.#kind = kind; }
  isFile() { return this.#kind === 'file'; }
  isDirectory() { return this.#kind === 'dir'; }
  isSymbolicLink() { return this.#kind === 'symlink'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
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

// A no-encoding read returns a Buffer in node — CC then calls Buffer methods on
// it (.toString('hex') for hashes/ids, .readUInt8/.readUInt32BE for binary/image
// parsing, Buffer.isBuffer for type dispatch). `data` is a Uint8Array; Buffer.from
// over its backing ArrayBuffer is a zero-copy VIEW of exactly these bytes. Without
// this the return was a bare Uint8Array — duck-close enough to pass smoke but
// silently wrong (.toString('hex') decimal-joins, .readUInt8 is undefined). This
// was the deferred "Buffer returns upgrade" (A1-audit finding #1, 2026-07-15).
function asBuffer(data) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function readFileSync(p, opts) {
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const fd = FSS.open(p, 'r');
  try {
    const data = readAll(fd);
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return asBuffer(data);
  } finally { FSS.close(fd); }
}

function writeFileSync(p, data, opts) {
  let bytes;
  if (typeof data === 'string') {
    // Honor the string encoding; never silently fall back to UTF-8 for one we
    // don't implement — that would corrupt bytes and hide the gap.
    const enc = (typeof opts === 'string' ? opts : opts?.encoding) ?? 'utf8';
    if (enc === 'utf8' || enc === 'utf-8') bytes = te.encode(data);
    else if (isLatin1(enc)) bytes = latin1Encode(data);
    else throw new Error(`node-shim: fs.writeFileSync encoding '${enc}' not implemented`);
  } else {
    bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
  }
  // fd-as-first-arg form: fs.writeFileSync(fd, data) writes to the caller's ALREADY
  // OPEN fd (at its current position) and must NOT open/close a path. Claude Code's
  // atomic config writer relies on exactly this: openSync(tmp, O_CREAT|O_EXCL) ->
  // writeFileSync(fd, json) -> fsync -> close -> rename(tmp, ~/.claude.json).
  // Treating the fd NUMBER as a path (FSS.open(8,'w')) wrote the bytes to a bogus
  // file literally named "8" and left the real temp fd 0 bytes, so the rename wiped
  // the config to 0 bytes ("config not persisted" / "Unexpected end of JSON input"
  // daily-driver bug). Characterized by node-shim-fs.test.cjs.
  if (typeof p === 'number') { writeAll(p, bytes, null); return; }
  const fd = FSS.open(p, 'w');
  try { writeAll(fd, bytes, null); } finally { FSS.close(fd); }
}

function mkdirSync(p, opts) {
  if (opts?.recursive) {
    const abs = path.resolve(p);
    const isWin = (globalThis.process && process.platform === 'win32');
    const sep = isWin ? '\\' : '/';
    const segs = abs.split(/[\\/]/);
    // First segment is the root: '' (posix/rooted) or a drive like 'C:' (win).
    let cur = segs.shift() || '';
    for (const part of segs) {
      if (!part) continue;
      cur += sep + part;
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

// Encode string data honoring encoding (shared by writeFileSync/appendFileSync/
// writeSync); never silently mis-encode an unimplemented charset — fail loud.
function encodeStr(data, enc) {
  enc = enc || 'utf8';
  if (enc === 'utf8' || enc === 'utf-8') return te.encode(data);
  if (isLatin1(enc)) return latin1Encode(data);
  throw new Error(`node-shim: fs string encoding '${enc}' not implemented`);
}
// Turn a Uint8Array view into a standalone ArrayBuffer for FSS.write (which
// requires an ArrayBuffer, not a view).
function toArrayBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}
function writeAll(fd, bytes, position) {
  const ab = toArrayBuffer(bytes);
  let written = 0;
  while (written < ab.byteLength) {
    const chunk = written === 0 ? ab : ab.slice(written);
    written += FSS.write(fd, chunk, position == null ? -1 : position + written);
  }
  return written;
}

function appendFileSync(p, data, opts) {
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const bytes = typeof data === 'string' ? encodeStr(data, enc)
    : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
  // fd number given? append via that fd; else open path in append mode.
  if (typeof p === 'number') { writeAll(p, bytes, null); return; }
  const fd = FSS.open(p, 'a');
  try { writeAll(fd, bytes, null); } finally { FSS.close(fd); }
}

// fs.writeSync(fd, buffer[, offset[, length[, position]]]) OR
// fs.writeSync(fd, string[, position[, encoding]]). Returns bytes written.
function writeSync(fd, data, a, b, c) {
  let bytes, position;
  if (typeof data === 'string') {
    position = typeof a === 'number' ? a : null;
    bytes = encodeStr(data, b);
  } else {
    const view = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    const offset = typeof a === 'number' ? a : 0;
    const length = typeof b === 'number' ? b : view.length - offset;
    position = typeof c === 'number' ? c : null;
    bytes = view.subarray(offset, offset + length);
  }
  const ab = toArrayBuffer(bytes);
  return FSS.write(fd, ab, position == null ? -1 : position);
}

function rmSync(p, opts) {
  let l;
  try { l = lstatSync(p); } catch (e) { if (opts?.force && e.code === 'ENOENT') return; throw e; }
  if (l.isDirectory()) {
    if (!opts?.recursive) return FSS.rmdir(p);
    for (const n of FSS.readdir(p)) rmSync(path.join(p, n), opts);
    return FSS.rmdir(p);
  }
  return FSS.unlink(p);
}

// fs.mkdtempSync(prefix): create a uniquely-suffixed dir (Node appends 6 random
// chars, mode 0o700) and return its path.
const MKDTEMP_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function mkdtempSync(prefix) {
  for (let attempt = 0; attempt < 16; attempt++) {
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += MKDTEMP_CHARS[Math.floor(Math.random() * MKDTEMP_CHARS.length)];
    const p = prefix + suffix;
    try { FSS.mkdir(p, 0o700); return p; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('node-shim: fs.mkdtempSync exhausted unique-name attempts');
}

function direntFor(parentPath, name) {
  let kind = 'file';
  try { kind = FSS.lstat(path.join(parentPath, name)).kind; } catch { /* broken link etc → treat as file */ }
  return new Dirent(name, kind, parentPath);
}

// Shared readdir core: honours { withFileTypes, recursive } like host node.
// recursive descends real directories only (lstat kind, no symlink follow);
// without withFileTypes it yields path strings relative to `p` (node's shape).
function readdirCore(p, opts) {
  const wft = !!(opts && opts.withFileTypes);
  const recursive = !!(opts && opts.recursive);
  if (!recursive) {
    const names = FSS.readdir(p);
    return wft ? names.map((n) => direntFor(p, n)) : names;
  }
  const out = [];
  const walk = (dir, relBase) => {
    for (const n of FSS.readdir(dir)) {
      const rel = relBase ? path.join(relBase, n) : n;
      const d = direntFor(dir, n);
      out.push(wft ? d : rel);
      if (d.isDirectory()) walk(path.join(dir, n), rel);
    }
  };
  walk(p, '');
  return out;
}

const fsMod = {
  constants,
  readFileSync, writeFileSync, mkdirSync, readSync,
  statSync, lstatSync,
  fstatSync: (fd) => new Stats(FSS.fstat(fd)),
  existsSync: (p) => { try { FSS.stat(p); return true; } catch { return false; } },
  realpathSync: (p) => FSS.realpath(p),
  readlinkSync: (p) => FSS.readlink(p),
  readdirSync: (p, opts) => readdirCore(p, opts),
  opendirSync: (p) => {
    // Minimal Dir: an async-iterable + read()/close() over an eager Dirent list,
    // enough for a `for await (const d of await opendir(p))` walker.
    const ents = readdirCore(p, { withFileTypes: true });
    let i = 0;
    return {
      path: p,
      read: async () => (i < ents.length ? ents[i++] : null),
      close: async () => {},
      closeSync: () => {},
      [Symbol.asyncIterator]() { return { next: async () => (i < ents.length ? { value: ents[i++], done: false } : { value: undefined, done: true }) }; },
    };
  },
  rmdirSync: (p) => FSS.rmdir(p),
  unlinkSync: (p) => FSS.unlink(p),
  renameSync: (a, b) => FSS.rename(a, b),
  accessSync: (p, m) => FSS.access(p, m ?? constants.F_OK),
  openSync: (p, flags) => FSS.open(p, flagsToString(flags ?? 'r')),
  closeSync: (fd) => FSS.close(fd),
  copyFileSync: (a, b) => writeFileSync(b, readFileSync(a)),
  symlinkSync: (target, p) => FSS.symlink(target, p),
  chmodSync: (p, m) => FSS.chmod(p, m),
  appendFileSync,
  writeSync,
  rmSync,
  mkdtempSync,
  // fsync/fdatasync durability barriers: this tjs sync-fs patch exposes no fsync
  // primitive. DIVERGENCE (documented, best-effort like futimes): resolve
  // without forcing a flush. Correct RESULT (bytes already written via FSS.write);
  // only the durability guarantee is weaker. A path needing a hard flush barrier
  // is a future wall — wire a tjs fsync primitive then.
  fsyncSync: () => {},
  fdatasyncSync: () => {},
};

// Node's utimes/lutimes accept a Date, a number (Unix epoch SECONDS), or a
// numeric string; tjs.utime/tjs.lutime take milliseconds (they divide by 1000
// for uv_fs_[l]utime, which keeps sub-second precision as a fractional second).
// Convert to ms so a filesystem mtime-precision probe (create file → utimes →
// stat, checking mtime%1000) sees real ms resolution.
function timeToMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'bigint') return Number(t) * 1000;
  if (typeof t === 'number') return t * 1000;
  if (typeof t === 'string') { const n = Number(t); return Number.isFinite(n) ? n * 1000 : Date.now(); }
  return Date.now();
}

// fs.promises FileHandle over a raw FSS fd. Node's FileHandle is richer, but
// the shim provides the members deps actually reach: `fd` (a real inheritable
// OS fd), close(), and best-effort read/write/stat/appendFile that reuse the
// sync core. Not an EventEmitter (node's isn't relied on here).
function makeFileHandle(fd, p) {
  let closed = false;
  return {
    fd,
    async close() { if (!closed) { closed = true; FSS.close(fd); } },
    async read(buffer, offset, length, position) {
      const bytesRead = readSync(fd, buffer, offset ?? 0, length ?? buffer.length, position ?? null);
      return { bytesRead, buffer };
    },
    async write(data, a, b, c) {
      const bytesWritten = writeSync(fd, data, a, b, c);
      return { bytesWritten, buffer: data };
    },
    async writeFile(data, opts) { writeAll(fd, typeof data === 'string' ? encodeStr(data, typeof opts === 'string' ? opts : opts?.encoding) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length), null); },
    async appendFile(data, opts) { writeAll(fd, typeof data === 'string' ? encodeStr(data, typeof opts === 'string' ? opts : opts?.encoding) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length), null); },
    async stat() { return new Stats(FSS.fstat(fd)); },
    // FileHandle.chmod: the bundle's atomic write (Write-overwrite + Edit) writes
    // a temp file then RESTORES the original file's mode via `await handle.chmod`
    // ("Applied original permissions to temp file"). Missing this method made
    // every overwrite/Edit of an existing file throw a bare "not a function"
    // (Write of a NEW file skips it — no original mode to restore). No fd-based
    // fchmod primitive exists; chmod the captured path (same inode).
    async chmod(mode) { FSS.chmod(p, mode); },
    async sync() {},
    async datasync() {},
    // `await using fh = await fs.promises.open(...)` (bundle ≥2.1.204 Bash-tool
    // output readers) requires @@asyncDispose; without it the declaration throws
    // a code-less TypeError and every Bash result degrades to the persisted-file
    // detour. Node's FileHandle disposal is close().
    async [Symbol.asyncDispose]() { await this.close(); },
  };
}

const promises = {
  readFile: async (p, opts) => {
    const enc = typeof opts === 'string' ? opts : opts?.encoding;
    const data = await tjs.readFile(p); // Uint8Array, verified against pinned tjs v26.6.0
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return asBuffer(data);
  },
  writeFile: async (p, data) => { writeFileSync(p, data); },
  utimes: async (p, atime, mtime) => { await tjs.utime(p, timeToMs(atime), timeToMs(mtime)); },
  lutimes: async (p, atime, mtime) => { await tjs.lutime(p, timeToMs(atime), timeToMs(mtime)); },
  stat: async (p) => statSync(p),
  lstat: async (p) => lstatSync(p),
  mkdir: async (p, opts) => mkdirSync(p, opts),
  readdir: async (p, opts) => readdirCore(p, opts),
  opendir: async (p) => fsMod.opendirSync(p),
  access: async (p, m) => FSS.access(p, m ?? constants.F_OK),
  realpath: async (p) => FSS.realpath(p),
  readlink: async (p) => FSS.readlink(p),
  unlink: async (p) => FSS.unlink(p),
  rename: async (a, b) => FSS.rename(a, b),
  rmdir: async (p) => FSS.rmdir(p),
  copyFile: async (a, b) => { writeFileSync(b, readFileSync(a)); },
  appendFile: async (p, data, opts) => { appendFileSync(p, data, opts); },
  chmod: async (p, m) => FSS.chmod(p, m),
  symlink: async (target, p) => FSS.symlink(target, p),
  // hardlink: no SYNC primitive in the sync-fs patch, but tjs exposes an async
  // uv link — use it for the async surface (linkSync remains a wall).
  link: async (existing, p) => { await tjs.link(existing, p); },
  mkdtemp: async (prefix) => mkdtempSync(prefix),
  // fs.promises.open(path, flags, mode) -> FileHandle. The Bash tool opens its
  // per-command log file here and passes the FileHandle's real fd as child
  // stdio ["pipe", fh.fd, fh.fd] so the subprocess writes stdout/stderr into
  // the file; the tool then closes its own fd (the spawned child keeps the
  // inherited dup — see child_process.cjs numeric-fd stdio + the tjs UV_INHERIT_FD
  // patch) and reads the file back for the result. FSS.open returns a real,
  // non-CLOEXEC (inheritable) fd, which is exactly what that pattern needs.
  // FileHandle carries the fd plus the handful of methods the shape needs
  // (close/read/write/stat/appendFile) routed through the existing sync core.
  open: async (p, flags, mode) => makeFileHandle(FSS.open(p, flagsToString(flags)), p),
  fsync: async () => {},       // best-effort (see fsyncSync note)
  fdatasync: async () => {},
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

// Node's callback fs APIs take an optional options arg before the callback; the
// cb is always last. Route each through its promises twin so behavior matches.
const cbWrap = (pfn) => (...args) => {
  const cb = args.pop();
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  pfn(...args).then((v) => cb(null, v), (e) => cb(e));
};
for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'access', 'readdir',
  'realpath', 'readlink', 'mkdir', 'unlink', 'rename', 'rmdir', 'copyFile', 'rm', 'opendir',
  'utimes', 'lutimes', 'appendFile', 'chmod', 'symlink', 'link', 'mkdtemp', 'fsync', 'fdatasync']) {
  fsMod[name] = cbWrap(promises[name]);
}
// fs.write / fs.read: callback receives (err, bytes, buffer) — extra trailing
// arg beyond cbWrap's (err, val) shape, so wire them explicitly.
fsMod.write = function write(fd, data, a, b, c, d) {
  // write(fd, buffer[, offset[, length[, position]]], cb) OR
  // write(fd, string[, position[, encoding]], cb)
  const args = [a, b, c, d].filter((x) => typeof x !== 'function');
  const cb = [a, b, c, d].find((x) => typeof x === 'function') || (() => {});
  try {
    const n = typeof data === 'string' ? writeSync(fd, data, args[0], args[1]) : writeSync(fd, data, args[0], args[1], args[2]);
    cb(null, n, data);
  } catch (e) { cb(e); }
};
fsMod.read = function read(fd, buffer, offset, length, position, cb) {
  try { const n = readSync(fd, buffer, offset, length, position); cb(null, n, buffer); }
  catch (e) { cb(e); }
};
// fs.futimes(fd, atime, mtime, cb): this tjs build exposes no fd-based utime
// primitive reachable from a raw fd (uv_fs_futime lives only on a tjs File
// object, not the FSS sync fds we use). DIVERGENCE (documented, best-effort):
// resolve without setting times. The bundle's futimes calls are not on the
// startup mtime-precision path (that uses utimes on a path); a path that
// genuinely needs fd-based times is a future wall — wire a tjs File handle then.
fsMod.futimes = (fd, atime, mtime, cb) => { if (typeof cb === 'function') cb(null); };
promises.futimes = async () => {};
fsMod.open = (p, flags, mode, cb) => { const c = typeof cb === 'function' ? cb : (typeof mode === 'function' ? mode : flags); try { c(null, fsMod.openSync(p, typeof flags === 'string' || typeof flags === 'number' ? flags : 'r')); } catch (e) { c(e); } };
fsMod.close = (fd, cb) => { try { FSS.close(fd); if (cb) cb(null); } catch (e) { if (cb) cb(e); } };
fsMod.Stats = Stats;
fsMod.Dirent = Dirent;

// fs.watchFile / unwatchFile / watch (Task 4 wall): the -p bundle installs a
// config-file watcher via `fs.watchFile(path, opts, listener)` (its `mLt`
// helper) at startup. A missing method throws `TypeError: not a function` (the
// call is inside a try that swallows to the telemetry logger, but the throw
// still abandons that init step). Node returns a StatWatcher (an EventEmitter
// with ref/unref) from watchFile and an FSWatcher from watch.
// DIVERGENCE: these register but never FIRE change events — this tjs build's
// fs-watch surface is not wired to the sync-fs patch, and a one-shot `-p`
// run does not depend on live config-change notifications (the file is read
// once at startup). A path that genuinely needs change events is a future wall:
// wire tjs.watch then. Characterized by test/node-shim-fs-watch.test.cjs.
const { EventEmitter } = require('node:events');
const _watchers = new Map();
fsMod.watchFile = function watchFile(filename, options, listener) {
  if (typeof options === 'function') { listener = options; }
  const key = String(filename);
  let w = _watchers.get(key);
  if (!w) { w = new EventEmitter(); w.ref = () => w; w.unref = () => w; _watchers.set(key, w); }
  if (typeof listener === 'function') w.on('change', listener);
  return w;
};
fsMod.unwatchFile = function unwatchFile(filename, listener) {
  const key = String(filename);
  const w = _watchers.get(key);
  if (!w) return;
  if (typeof listener === 'function') w.removeListener('change', listener);
  else { w.removeAllListeners('change'); _watchers.delete(key); }
};
fsMod.watch = function watch(filename, options, listener) {
  if (typeof options === 'function') { listener = options; }
  const w = new EventEmitter();
  w.close = () => {};
  w.ref = () => w; w.unref = () => w;
  if (typeof listener === 'function') w.on('change', listener);
  return w;
};

module.exports = fsMod;

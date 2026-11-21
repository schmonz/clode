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
//   - stat/lstat/fstat return libuv's uv_stat_t (txiki-sync-stat-identity.patch):
//     size, mode, uid, gid as numbers; kind 'file'|'dir'|'symlink'|'other';
//     dev, ino, nlink, rdev, blksize, blocks, size64 as exact BigInts; and
//     atime/mtime/ctime/birthtime as <name>Sec + <name>Nsec BigInts. Stats and
//     BigIntStats below are built from that, as node builds them.
//   - symlink(target, linkpath) — same arg order as POSIX symlink(2) and
//     as node's fs.symlinkSync(target, path).
//   - errors are real Error instances with .code/.errno/.syscall set by the
//     C throw_errno() helper (e.g. ENOENT, EEXIST).
//
// tjs.readFile: probed against the pinned tjs v26.6.0 binary —
//   `build/tjs/tjs eval 'tjs.readFile("/etc/hosts").then(d => console.log(d.constructor.name, d.byteLength))'`
//   -> "Uint8Array 1681" (NOT ArrayBuffer). TextDecoder#decode accepts a
//   Uint8Array directly, so promises.readFile decodes it with no extra copy.
//
// PROC_FD_IS_LINUX_ONLY — the rule: when process.platform is not 'linux', this
// process's own descriptor directory (/proc/self/fd, /proc/<own pid>/fd) is not
// Linux's magic-link procfs. Every node:fs operation on it, or on anything beneath
// it, throws ENOENT in the engine's own error shape, except READING one descriptor
// by name (open /proc/self/fd/N read-only), which still reaches the kernel. The
// rule is FALSE on the reference box: on Linux it never fires, so quaude, naude and
// Claude are identical there. macOS has no /proc, so the answer there is the ENOENT
// the engine would have given anyway. Another process's /proc/<pid>/fd is not ours
// to hide (the carve reads it only to find a socket's owner, in a Linux format).
//
// Why: a quaude for an OS that upstream does not build (NetBSD, illumos, the other
// BSDs) runs the LINUX carve, whose platform is constant-folded to "linux". That
// carve reads /proc/self/fd as Linux's magic links: it probes readlink of a
// descriptor and stat of /proc/self/fd, and when they answer it writes through
// /proc/self/fd/<dirfd>/<name>. Measured with real node on NetBSD 11 (2026-09-27):
// the procfs answers readlink for a DIRECTORY descriptor (EINVAL for a file) and
// lets mkdir/create through a directory descriptor, then refuses rename and unlink
// there with EROFS. So Write and Edit failed (the NetBSD spike, 2026-09-26:
// floor-probe C1 and B4). With the directory hidden, the carve takes its own
// `Symbol("no procfs")` route, the one it takes on a Linux box without /proc.
//
// Why reading one descriptor is the exception: NetBSD's procfs opens it the way
// Linux does (a fresh open of the same file, measured: its own offset), and the
// carve's auth-token readers (CLAUDE_CODE_{OAUTH_TOKEN,API_KEY,WEBSOCKET_AUTH}_
// FILE_DESCRIPTOR) read a non-socket descriptor exactly so: open /proc/self/fd/N
// "r" (the darwin carve says /dev/fd/N; a socket is read directly). Hiding it too
// (0e24947) turned a token on a file descriptor into "Not logged in" on NetBSD.
// The one carve open of a descriptor for WRITING is the TUI's nonblocking stdout
// (O_WRONLY|O_NONBLOCK on /proc/self/fd/1); installed on NetBSD, a turn's answer
// does not paint until the next keystroke (tui-probe D1 turn=false 7 of 8 runs,
// against 0 of 7 with it hidden; the same before F1). Hidden, the TUI takes the
// not-installed route that macOS quaude always takes. _FSS_PATH_ARGS names which
// arguments of each primitive are paths (symlink's first argument is the link's
// text, not a lookup). BACKLOG.md ("The NetBSD spike found three bugs") lists every
// carve site this rule turns.
const _PROC_FD = /^\/proc\/(self|\d+)\/fd(?:\/(.*))?$/;
const _FSS_PATH_ARGS = {
  access: [0], chmod: [0], lstat: [0], mkdir: [0], open: [0], readdir: [0], readlink: [0],
  realpath: [0], rename: [0, 1], rmdir: [0], stat: [0], symlink: [1], unlink: [0],
};
function _refuseProcFdOffLinux(op, p, flags) {
  if (typeof p !== 'string') return;
  const m = _PROC_FD.exec(p);
  if (!m) return;
  const proc = globalThis.process;
  const platform = proc && proc.platform;
  if (!platform || platform === 'linux') return;
  if (m[1] !== 'self' && m[1] !== String(proc.pid)) return;   // not OUR descriptors
  if (op === 'open' && flags === 'r' && /^\d+$/.test(m[2] || '')) return;  // reading one descriptor
  // the engine's own shape, reshaped as node's like every engine error (internal/node-errors.cjs)
  const e = new Error(`ENOENT, ${op} '${p}'`);
  e.code = 'ENOENT';
  e.errno = require('./../internal/engine-constants.cjs').errno.ENOENT;
  e.syscall = op;
  throw require('../internal/node-errors.cjs').asNodeError(e, op, [p]);
}
const FSS = (() => {
  // every error the engine throws, node's shape (internal/node-errors.cjs)
  const raw = require('../internal/node-errors.cjs').nodeErrorsFss(globalThis.__tjs_fs_sync);
  if (!raw) return raw;
  const gated = Object.create(raw);   // every other primitive is inherited untouched
  for (const [op, at] of Object.entries(_FSS_PATH_ARGS)) {
    const fn = raw[op];
    if (typeof fn !== 'function') continue;
    gated[op] = function (...a) {
      for (const i of at) _refuseProcFdOffLinux(op, a[i], op === 'open' ? a[1] : undefined);
      return fn.apply(raw, a);
    };
  }
  return gated;
})();
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
const EC_FS = require('./../internal/engine-constants.cjs').fs;
const _isDarwin = (() => {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  return /^Mac/.test(np);
})();
const _isWin = (() => {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Win/.test(np)) return true;
  return !!(globalThis.process && globalThis.process.platform === 'win32');
})();
// Node's fs.chmod on Windows never throws for a normal mode — libuv's _wchmod
// only honors the write bit and ignores the rest. tjs can raise for a mode
// Windows can't represent, which aborts the bundle's atomic write (open temp ->
// writeFile -> chmod(restore original mode) -> rename over target): that chmod is
// wrapped in a try/catch that RETHROWS any error it doesn't recognize as
// "fchmod unsupported", so a throwing chmod leaves the ORIGINAL file untouched
// ("Edit did not apply on disk"). Match Node: best-effort, swallow on win32.
function chmodBestEffort(p, mode) {
  try { FSS.chmod(p, mode); }
  catch (e) { if (!_isWin) throw e; }
}
// THE UMASK, as the kernel applies it. node's open(2) and mkdir(2) take a mode and the kernel masks it
// with the process umask. The engine's FSS.open takes no mode, so openPath() applies the caller's mode
// itself and needs the umask: read off a directory made 0777 (mkdir masks all nine bits; a file made
// 0666 would say nothing of the execute bits), once per process, in the directory being written.
// Until 2026-11-19 it was inferred from a created file's mode with a guessed execute bit; and
// process.umask() is still a constant 022 (process.cjs), not this.
let _umask = null;
function umaskIn(dir) {
  if (_umask !== null) return _umask;
  const probe = path.join(dir, `.clode-umask-${_rand()}`);
  try {
    FSS.mkdir(probe, 0o777);
    try { _umask = ~Number(FSS.stat(probe).mode) & 0o777; } finally { try { FSS.rmdir(probe); } catch { /* best effort */ } }
  } catch { return 0o022; }
  return _umask;
}
const _rand = () => `${(globalThis.process && process.pid) || 0}-${Math.random().toString(36).slice(2, 10)}`;
// tjs's rename (__tjs_fs_sync.rename, mod_fs_sync.c) is the C library rename(a,b)
// with no _WIN32 special-casing. POSIX rename(2) atomically REPLACES an existing
// target; the Windows CRT rename() instead FAILS (errno EEXIST, sometimes EACCES/
// EPERM) when the destination exists. The bundle's atomic write ends in
// rename(temp, target) OVER the existing file, so on Windows that step throws, the
// write aborts, unlink(temp) runs, and the ORIGINAL file is left untouched — the
// "Edit did not apply on disk" bug. Emulate POSIX replace on win32 only: drop the
// existing target, then rename. Non-atomic on this fallback path (a crash in the gap
// loses the destination) — acceptable for an edit, and it NEVER runs on POSIX, where
// FSS.rename already replaces. node's fs.rename is likewise replace-on-Windows
// (libuv passes MOVEFILE_REPLACE_EXISTING), so this matches node's contract.
function renameReplace(a, b) {
  try {
    FSS.rename(a, b);
  } catch (e) {
    if (_isWin && e && (e.code === 'EEXIST' || e.code === 'EACCES' || e.code === 'EPERM')) {
      FSS.unlink(b);      // remove the existing destination, then retry the rename
      FSS.rename(a, b);
    } else {
      throw e;
    }
  }
}
// fs.constants comes from the ENGINE (internal/engine-constants.cjs).
//
// What used to be here: `const O = _isDarwin ? {darwin values} : {linux values}`,
// which handed Linux's numbers to every target that was neither. Measured against
// real node on the NetBSD guest, 8 of 11 were wrong — O_APPEND 1024 vs 8,
// O_NONBLOCK 2048 vs 4, O_CREAT 64 vs 512 — and these feed flagsToMode() below,
// so opens were being translated with another platform's bits. Nothing caught it
// because a wrong constant does not throw.
const constants = EC_FS;
const O = constants;

// OPENING A PATH AS NODE DOES. node turns a string flag into O_* bits (lib/internal/fs/utils.js
// stringToFlags) and hands the bits and the mode to open(2). The engine's sync open takes only
// 'r'|'w'|'a'|'r+'|'w+' (optionally 'n'-suffixed for O_NONBLOCK; mod_fs_sync.c js_fss_open), always
// creates 0666 minus the umask, and knows no O_EXCL, O_DIRECTORY or O_NOFOLLOW. Collapsing node's
// flags onto those five (what this file did until 2026-11-19) made `openSync(f, "wx")`,
// `writeFileSync(f, d, {flag: "wx"})` and O_WRONLY|O_CREAT|O_EXCL overwrite an existing file where
// node throws EEXIST (an exclusive create, a lock, was not one); O_CREAT without O_TRUNC truncated;
// O_DIRECTORY and O_NOFOLLOW opened a file; a create mode was applied to a file that already existed
// (node applies it only when it creates) and `fs.promises.open(p, flags, mode)` dropped it -- which
// is how 2.1.283's config writer, `open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0o600)` then rename, left
// ~/.claude/.claude.json 0644 (BACKLOG; found by test/node-shim-differential.test.cjs).
//
// So openPath() keeps node's bits and answers each one the engine cannot:
//   O_CREAT, path absent   createExclusive() below: the file is made, moded and put in place by
//                          primitives that are each atomic, so nobody else's file is truncated or
//                          taken and nobody else ever sees it at a mode other than the caller's
//   O_EXCL with O_CREAT    EEXIST from that same atomic claim, not from a check before an open
//   O_NOFOLLOW             ELOOP when the path is a symlink, checked before AND after the open
//                          (identity: the file opened must be the one lstat names)
//   O_DIRECTORY            ENOTDIR when what opened is not a directory (closed first)
//   no O_TRUNC             an existing file opens 'r+', never 'w', so its bytes stay
//   no O_CREAT             a missing path opens 'r'/'r+', so the engine says ENOENT
// O_NONBLOCK is passed through ('n'): the bundle's drainStdin opens /dev/tty O_RDONLY|O_NONBLOCK and
// readSync()s until EAGAIN, and a blocking open there wedged the engine
// (test/node-shim-fs-nonblock.test.cjs). The engine has no read+append, so a+ opens 'a'. What is
// still not node's is in BACKLOG ("node-shim's exclusive create ..."): O_WRONLY without O_TRUNC on an
// existing file needs read permission ('r+'); O_TRUNC|O_NOFOLLOW can truncate a link swapped in after
// the check; and where the filesystem refuses a symlink (Windows without the privilege, FAT) the
// create falls back to check-then-open, with its window.
const STRING_FLAGS = (() => {
  const S = O.O_SYNC || 0;
  const W = O.O_TRUNC | O.O_CREAT | O.O_WRONLY;
  const WP = O.O_TRUNC | O.O_CREAT | O.O_RDWR;
  const A = O.O_APPEND | O.O_CREAT | O.O_WRONLY;
  const AP = O.O_APPEND | O.O_CREAT | O.O_RDWR;
  const X = O.O_EXCL || 0;
  return {
    r: O.O_RDONLY, rs: O.O_RDONLY | S, sr: O.O_RDONLY | S, 'r+': O.O_RDWR, 'rs+': O.O_RDWR | S, 'sr+': O.O_RDWR | S,
    w: W, wx: W | X, xw: W | X, 'w+': WP, 'wx+': WP | X, 'xw+': WP | X,
    a: A, ax: A | X, xa: A | X, as: A | S, sa: A | S,
    'a+': AP, 'ax+': AP | X, 'xa+': AP | X, 'as+': AP | S, 'sa+': AP | S,
  };
})();
function toOflags(flags) {
  if (typeof flags === 'number') return flags;
  if (flags === undefined || flags === null) return O.O_RDONLY;
  if (typeof flags === 'string' && Object.prototype.hasOwnProperty.call(STRING_FLAGS, flags)) return STRING_FLAGS[flags];
  const e = new TypeError(`The argument 'flags' is invalid. Received ${JSON.stringify(flags)}`);
  e.code = 'ERR_INVALID_ARG_VALUE';
  throw e;
}
// An errno error as the engine would throw it, reshaped as node's (internal/node-errors.cjs).
function sysError(code, op, p) {
  const e = new Error(`${code}, ${op} '${p}'`);
  e.code = code;
  e.errno = require('./../internal/engine-constants.cjs').errno[code];
  e.syscall = op;
  return require('../internal/node-errors.cjs').asNodeError(e, op, [p]);
}
// node's path-argument check (validatePath): a string, a Buffer or TypedArray, or a URL; anything else is
// ERR_INVALID_ARG_TYPE, before any syscall (measured, node 24.21.0: fs.promises.lstat() and mkdtemp()
// reject so; the engine took `undefined` as the path 'undefined' and said ENOENT).
function validatePathArg(v, name = 'path') {
  if (typeof v === 'string' || ArrayBuffer.isView(v) || (v !== null && typeof v === 'object' && typeof v.href === 'string')) return v;
  throw require('../internal/node-errors.cjs').invalidArgType(`The "${name}" argument must be of type string or an instance of Buffer or URL`, v);
}
// An engine error retold under the syscall node's own implementation names (readdirSync: scandir; opendir:
// opendir, with no path; the JS realpath walk: lstat or stat; utimesSync: utime), code, errno and text kept.
function retold(e, syscall, p) {
  if (!e || typeof e.code !== 'string' || typeof e.syscall !== 'string') return e;
  const msg = String(e.message);
  const at = msg.indexOf(`, ${e.syscall}`);
  const head = at < 0 ? msg : msg.slice(0, at);
  e.syscall = syscall;
  if (p === undefined) { delete e.path; e.message = `${head}, ${syscall}`; } else { e.path = p; e.message = `${head}, ${syscall} '${p}'`; }
  return e;
}
// The error node's JS realpath (fs.realpath, fs.realpathSync; not their .native, not fs.promises.realpath)
// reports for a path that does not resolve: it lstat()s each prefix of the resolved path in turn and
// stat()s a prefix that is a symlink, so a missing component says lstat and a dangling link says stat
// (measured, node 24.21.0). Any other failure keeps the engine's realpath error.
function realpathWalkError(p, e) {
  if (typeof p !== 'string') return e;
  const abs = path.resolve(p);
  let cur = path.parse(abs).root;
  for (const part of abs.slice(cur.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let l;
    try { l = FSS.lstat(cur); } catch (le) { return retold(le, 'lstat', cur); }
    if (typeIs(l.mode, 'symlink')) { try { FSS.stat(cur); } catch (se) { return retold(se, 'stat', cur); } }
  }
  return e;
}
const realpathJs = (p) => { try { return FSS.realpath(p); } catch (e) { throw realpathWalkError(p, e); } };
// CREATE EXCLUSIVELY, from primitives that are each atomic (the engine has no O_EXCL, no link(2) and
// no fchmod):
//   1. mkdir a private directory beside the path, 0700: exclusive, so it is ours and nobody else can
//      reach into it;
//   2. open the file inside it and chmod it to the caller's mode minus the umask: no one else can see
//      it at any other mode, because no one else can enter the directory;
//   3. CLAIM the path with symlink(2), which never follows and fails EEXIST if anything is there: the
//      exclusive create's one atomic step; a racing creator either got there first (we throw EEXIST and
//      tidy up) or finds our link;
//   4. rename the file over our own link (rename never follows the link it replaces) and rmdir.
// The descriptor opened in 2 is the file now at the path. Returns null when the filesystem cannot
// make a symlink (EPERM, ENOSYS, ENOTSUP...): the caller falls back to check-then-open.
function createExclusive(p, base, mode) {
  const dir = path.dirname(p);
  const priv = path.join(dir, `.clode-create-${_rand()}`);
  const inner = path.join(priv, 'f');
  // the open's errors, as the open would have said them (ENOENT, ENOTDIR, EACCES, EROFS of the parent)
  try { FSS.mkdir(priv, 0o700); } catch (e) { throw e && e.code ? sysError(e.code, 'open', p) : e; }
  let fd = -1;
  let placed = false;
  try {
    fd = FSS.open(inner, base === 'r' ? 'w' : base);
    if (typeof mode === 'number') {
      const want = mode & 0o7777 & ~umaskIn(dir);
      if (want !== (Number(FSS.fstat(fd).mode) & 0o7777)) chmodBestEffort(inner, want);
    }
    if (base === 'r') { FSS.close(fd); fd = -1; fd = FSS.open(inner, 'r'); }
    try {
      FSS.symlink(path.join(path.basename(priv), 'f'), p);
    } catch (e) {
      if (e.code === 'EEXIST') throw sysError('EEXIST', 'open', p);
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EACCES' || e.code === 'EROFS') throw e;
      FSS.close(fd); fd = -1;
      return null;
    }
    FSS.rename(inner, p);
    placed = true;
    return fd;
  } catch (e) {
    if (fd >= 0) { try { FSS.close(fd); } catch { /* closing */ } }
    throw e;
  } finally {
    if (!placed) { try { FSS.unlink(inner); } catch { /* not made */ } }
    try { FSS.rmdir(priv); } catch { /* best effort */ }
  }
}

function openPath(p, flags, mode) {
  const of = toOflags(flags);
  const has = (b) => !!b && (of & b) === b;
  const creat = has(O.O_CREAT);
  const excl = creat && has(O.O_EXCL);
  const rw = of & 3;
  const nb = has(O.O_NONBLOCK) ? 'n' : '';
  const createBase = has(O.O_APPEND) ? 'a' : rw === O.O_RDWR ? 'w+' : rw === O.O_RDONLY ? 'r' : 'w';
  let pre = null;
  try { pre = FSS.lstat(p); } catch { /* absent, or the open below says why */ }
  if (creat && !pre) {
    try {
      const fd = createExclusive(p, createBase, mode);
      if (fd !== null) return directoryCheck(fd, p, has);
    } catch (e) {
      if (e.code !== 'EEXIST' || excl) throw e;
    }
    try { pre = FSS.lstat(p); } catch { /* still absent: the fallback below creates it */ }
  }
  const isLink = !!pre && typeIs(pre.mode, 'symlink');
  if (excl && pre) throw sysError('EEXIST', 'open', p);
  if (has(O.O_NOFOLLOW) && isLink) throw sysError('ELOOP', 'open', p);
  let exists = !!pre;
  if (isLink) { try { FSS.stat(p); } catch { exists = false; } }
  let base;
  if (!creat && !exists) base = rw === O.O_RDONLY ? 'r' : 'r+';
  else if (!exists) base = createBase === 'r' ? 'w' : createBase;
  else if (has(O.O_APPEND)) base = 'a';
  else if (rw === O.O_RDONLY) base = 'r';
  else if (has(O.O_TRUNC)) base = rw === O.O_RDWR ? 'w+' : 'w';
  else base = 'r+';
  let fd = FSS.open(p, base + nb);
  if (has(O.O_NOFOLLOW)) {
    let same = false;
    try {
      const now = FSS.lstat(p);
      const got = FSS.fstat(fd);
      same = !typeIs(now.mode, 'symlink') && String(now.ino) === String(got.ino) && String(now.dev) === String(got.dev);
    } catch { /* gone: not the file we checked */ }
    if (!same) { FSS.close(fd); throw sysError('ELOOP', 'open', p); }
  }
  if (!exists && creat) {
    // the fallback create (no symlinks here): chmod after, with its window (BACKLOG)
    if (typeof mode === 'number') {
      const want = mode & 0o7777 & ~umaskIn(path.dirname(p));
      try { if (want !== (Number(FSS.fstat(fd).mode) & 0o7777)) chmodBestEffort(p, want); } catch (e) { FSS.close(fd); throw e; }
    }
    if (createBase === 'r') { FSS.close(fd); fd = FSS.open(p, 'r' + nb); }
  }
  return directoryCheck(fd, p, has);
}
function directoryCheck(fd, p, has) {
  if (has(O.O_DIRECTORY)) {
    let dir = false;
    try { dir = typeIs(FSS.fstat(fd).mode, 'dir'); } catch { /* not a directory we can tell */ }
    if (!dir) { FSS.close(fd); throw sysError('ENOTDIR', 'open', p); }
  }
  return fd;
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

// A path's type, from the engine's st_mode bits (S_IFMT): every is*() reads them, as node's do. The
// engine's `kind` is only file/dir/symlink/other, so keying on it answered isFIFO(), isSocket(),
// isBlockDevice() false for every path and isCharacterDevice() false for /dev/null; the 2.1.283
// bundle's readInheritedFdSync then refused every CLAUDE_CODE_*_FILE_DESCRIPTOR pipe ("not a pipe or
// socket"). The S_IF* values are POSIX's, and MSVC's struct stat uses the same ones.
const S_IFMT = 0o170000;
const S_IF = { file: 0o100000, dir: 0o040000, symlink: 0o120000, fifo: 0o010000, socket: 0o140000, char: 0o020000, block: 0o060000 };
const typeIs = (mode, t) => ((Number(mode) >>> 0) & S_IFMT) === S_IF[t];

// fs.Stats and fs.BigIntStats, built as node builds them (lib/internal/fs/utils.js) from what the
// engine's sync stat hands over (spike/quickjs/patches/txiki-sync-stat-identity.patch): libuv's
// uv_stat_t, with every 64-bit field as an exact BigInt and each time as seconds + nanoseconds.
// node fills a Float64Array (numbers) or a BigInt64Array (bigint: true) from that same struct, so a
// number here is the BigInt's nearest double and a bigint is its signed 64-bit reading; the times
// are node's own arithmetic, msFromTimeSpec (sec * 1e3 + nsec / 1e6) and nsFromTimeSpecBigInt
// (sec * 1e9 + nsec, the Ms being that / 1e6, truncated). The four Dates are node's lazy getters
// on the prototype: computed on first read from the *Ms field, rounded, then an own property, so
// the own keys (and JSON.stringify) are node's. Until this engine fix dev, ino and rdev were 0,
// nlink 1, every time the whole-second mtime and `{ bigint: true }` was ignored: two different
// files had one identity, and every character device was /dev/null (BACKLOG).
const STAT_INTS = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks'];
const STAT_TIMES = ['atime', 'mtime', 'ctime', 'birthtime'];
// AN ENGINE WITHOUT IDENTITY (one that predates txiki-sync-stat-identity.patch: the last release's,
// which the CI bootstrap runs the builder on) reports exactly two of these fields truthfully, mode
// and size. Its other answers are absent (dev, ino, nlink, rdev, blksize, blocks, every time but a
// whole-second mtime) or unverified (uid/gid, signed before that patch). So a Stats from it carries
// those two, and READING ANY OTHER FIELD refuses with ERR_CLODE_ENGINE_FLOOR -- never an invented
// value. The refusal sits on the read, not on the stat call, because the stat call is not where a
// wrong answer happens: node-shim's own copyFileSync reads `.mode`, and refusing at the call made
// every engine build on the last release's engine die there (CI run 44443821699), though the whole
// build -- measured on that engine -- reads `mode` and nothing else.
// test/node-shim-fs-engine-floor.test.cjs drives every field. The engine quaude SHIPS never takes
// this path: scripts/engine-api-floor.cjs refuses it at build time (role 'runtime').
const STALE_KEPT = new Set(['mode', 'size']);
const hasIdentity = (raw) => typeof raw.ino === 'bigint';
// A refusal only helps if it is seen, and the bundle (like any program) has catch-all callers that
// would turn it into "file not found" or worse: the first one also goes to stderr, once.
let _floorSaid = false;
function floorError(field) {
  const e = new Error(`node-shim: this engine's sync stat carries no ${field} (it predates `
    + 'txiki-sync-stat-identity.patch, and reports only mode and size exactly); rebuild it: ./build.sh --only engine.compile');
  e.code = 'ERR_CLODE_ENGINE_FLOOR';
  if (!_floorSaid) { _floorSaid = true; try { console.error(e.message); } catch { /* best effort */ } }
  // EVERY refusal, with its stack, for a gate that must hear the ones a caller swallowed
  // (CLODE_ENGINE_FLOOR_LOG; build-leg fails an engine phase on a non-empty log).
  require('../internal/engine-floor-log.cjs').engineFloorLog(e.message);
  return e;
}
// Writable, as node's fields are: assigning one replaces the refusal with the value assigned.
function refuseField(obj, f) {
  Object.defineProperty(obj, f, {
    enumerable: true,
    configurable: true,
    get() { throw floorError(f); },
    set(v) { Object.defineProperty(this, f, { value: v, writable: true, enumerable: true, configurable: true }); },
  });
}
function staleStats(obj, raw, conv, timeSuffixes) {
  for (const f of STAT_INTS) {
    if (STALE_KEPT.has(f)) obj[f] = conv(raw[f]);
    else refuseField(obj, f);
  }
  for (const sfx of timeSuffixes) for (const t of STAT_TIMES) refuseField(obj, t + sfx);
}
function rawInt(raw, f) { return f === 'size' ? raw.size64 : raw[f]; }
class StatsBase {
  isFile() { return typeIs(this.mode, 'file'); }
  isDirectory() { return typeIs(this.mode, 'dir'); }
  isSymbolicLink() { return typeIs(this.mode, 'symlink'); }
  isBlockDevice() { return typeIs(this.mode, 'block'); }
  isCharacterDevice() { return typeIs(this.mode, 'char'); }
  isFIFO() { return typeIs(this.mode, 'fifo'); }
  isSocket() { return typeIs(this.mode, 'socket'); }
}
class Stats extends StatsBase {
  constructor(raw) {
    super();
    if (!hasIdentity(raw)) { staleStats(this, raw, Number, ['Ms']); return; }
    for (const f of STAT_INTS) this[f] = Number(rawInt(raw, f));
    for (const t of STAT_TIMES) this[t + 'Ms'] = Number(raw[t + 'Sec']) * 1000 + Number(raw[t + 'Nsec']) / 1000000;
  }
}
class BigIntStats extends StatsBase {
  constructor(raw) {
    super();
    if (!hasIdentity(raw)) { staleStats(this, raw, (v) => BigInt(v), ['Ms', 'Ns']); return; }
    for (const f of STAT_INTS) this[f] = BigInt.asIntN(64, BigInt(rawInt(raw, f)));
    const ns = {};
    for (const t of STAT_TIMES) ns[t] = BigInt.asIntN(64, raw[t + 'Sec']) * 1000000000n + BigInt.asIntN(64, raw[t + 'Nsec']);
    for (const t of STAT_TIMES) this[t + 'Ms'] = ns[t] / 1000000n;
    for (const t of STAT_TIMES) this[t + 'Ns'] = ns[t];
  }
}
for (const C of [Stats, BigIntStats]) {
  for (const t of STAT_TIMES) {
    Object.defineProperty(C.prototype, t, {
      enumerable: true,
      configurable: true,
      get() { const d = new Date(Math.round(Number(this[t + 'Ms']))); Object.defineProperty(this, t, { value: d, writable: true, enumerable: true, configurable: true }); return d; },
      set(v) { Object.defineProperty(this, t, { value: v, writable: true, enumerable: true, configurable: true }); },
    });
  }
}
const makeStats = (raw, opts) => (opts && opts.bigint ? new BigIntStats(raw) : new Stats(raw));

// fs.Dirent — the shape readdir(withFileTypes) yields. FSS.readdir returns NAMES
// only (probed), so the entry kind comes from an lstat (no symlink follow, like
// node's d_type). `parentPath` is node's field (`path` is the deprecated alias).
class Dirent {
  #mode;
  constructor(name, mode, parentPath) { this.name = name; this.parentPath = parentPath; this.path = parentPath; this.#mode = mode; }
  isFile() { return typeIs(this.#mode, 'file'); }
  isDirectory() { return typeIs(this.#mode, 'dir'); }
  isSymbolicLink() { return typeIs(this.#mode, 'symlink'); }
  isBlockDevice() { return typeIs(this.#mode, 'block'); }
  isCharacterDevice() { return typeIs(this.#mode, 'char'); }
  isFIFO() { return typeIs(this.#mode, 'fifo'); }
  isSocket() { return typeIs(this.#mode, 'socket'); }
}

// To end of file, as node reads: the fstat size is a HINT. A procfs or sysfs file says 0 and is not
// empty, so stopping at the size read "" from /proc/version and /proc/self/cgroup, the files the
// carve's WSL and container checks read (test/node-shim-differential.test.cjs, DIFF-PROCFS-EMPTY).
// A file at its size costs one more read, which answers 0, as node's does. The reads are
// SEQUENTIAL (position -1: read(2), not pread(2)), as node's readFile is: a FIFO, a pipe or a tty
// cannot pread (ESPIPE), and a descriptor the caller handed over reads from where it stands.
function readAll(fd) {
  let out = new Uint8Array(Math.max(0, Number(FSS.fstat(fd).size) || 0));
  let got = 0;
  for (;;) {
    const room = out.length - got;
    const ab = FSS.read(fd, room > 0 ? Math.min(1 << 20, room) : 65536, -1);
    if (ab.byteLength === 0) break;
    if (got + ab.byteLength > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, got + ab.byteLength));
      bigger.set(out.subarray(0, got));
      out = bigger;
    }
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

// A descriptor is read from where it stands and left open, as node does (readFileSync(0) reads stdin).
function readFileSync(p, opts) {
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const own = typeof p !== 'number';
  const fd = own ? FSS.open(p, 'r') : p;
  try {
    const data = readAll(fd);
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return asBuffer(data);
  } finally { if (own) FSS.close(fd); }
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
  const o = typeof opts === 'object' && opts !== null ? opts : {};
  const fd = openPath(p, o.flag ?? 'w', o.mode);
  try { writeAll(fd, bytes, null); } finally { FSS.close(fd); }
}

// node's mkdir: `{ recursive: true }` makes each missing directory WITH the mode (the kernel applies the
// umask), returns the first directory it made (undefined when none), and refuses a path that exists as
// something else (EEXIST) or runs through a file (ENOTDIR). Until 2026-11-19 the recursive form made
// every directory 0777-minus-umask whatever the caller asked (0755 for a 0o700 ~/.claude subdirectory),
// returned undefined, and passed silently over a regular file (test/node-shim-differential.test.cjs,
// DIFF-MKDIR-RECURSIVE).
function mkdirSync(p, opts) {
  const o = typeof opts === 'number' ? { mode: opts } : (opts || {});
  const mode = o.mode ?? 0o777;
  if (o.recursive) {
    const abs = path.resolve(p);
    const isWin = (globalThis.process && process.platform === 'win32');
    const sep = isWin ? '\\' : '/';
    const segs = abs.split(/[\\/]/).filter(Boolean);
    // The root: '' (posix/rooted) or a drive like 'C:' (win).
    let cur = /^[\\/]/.test(abs) ? '' : segs.shift();
    let first;
    for (let i = 0; i < segs.length; i++) {
      cur += sep + segs[i];
      try {
        FSS.mkdir(cur, mode);
        if (first === undefined) first = cur;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let dir = false;
        try { dir = typeIs(FSS.stat(cur).mode, 'dir'); } catch { /* a dangling link: not a directory */ }
        if (!dir) throw sysError(i === segs.length - 1 ? 'EEXIST' : 'ENOTDIR', 'mkdir', p);
      }
    }
    // node's mkdirp walks the caller's own string by dirname(), so the first directory comes back in
    // the caller's form ('a' for 'a/b'), not resolved
    if (first !== undefined) {
      for (let q = String(p); ; q = path.dirname(q)) {
        if (path.resolve(q) === first) return q;
        if (path.dirname(q) === q) break;
      }
    }
    return first;
  }
  FSS.mkdir(p, mode);
  return undefined;
}

// node's readSync(fd, buffer, offsetOrOptions, length, position): 2.1.330 calls the OPTIONS form,
// `readSync(fd, buf, {position})`, which read 0 bytes here (length undefined) until 2026-11-21; with no
// offset or length node reads from offset 0 to the end of the buffer.
// As node (lib/fs.js): with 3 arguments or fewer, or an object third, the third is the options (offset 0,
// length to the end of the buffer, position null); otherwise `length |= 0`, so an absent length reads nothing.
function readSync(fd, buf, offset, length, position) {
  if (arguments.length <= 3 || (offset !== null && typeof offset === 'object')) {
    const o = offset == null ? {} : offset;
    if (typeof o !== 'object') {
      throw require('../internal/node-errors.cjs').invalidArgType('The "options" argument must be of type object', o);
    }
    offset = o.offset === undefined ? 0 : o.offset;
    length = o.length === undefined ? buf.byteLength - offset : o.length;
    position = o.position === undefined ? null : o.position;
  } else {
    length |= 0;
  }
  if (length === 0) return 0;
  const ab = FSS.read(fd, length, position ?? -1);
  const src = new Uint8Array(ab);
  buf.set(src, offset);
  return src.length;
}

// `{ throwIfNoEntry: false }`, node's rule exactly (lib/fs.js, measured against node 24): every stat
// form (statSync, fs.promises.stat, fs.stat) answers undefined for ENOENT and ENOTDIR; lstatSync for
// ENOENT only; fs.promises.lstat and fs.lstat ignore the option. Ignoring it everywhere threw where
// the 2.1.283 bundle expects undefined: one caller then read "absent" as "present", and one in the
// permission deny path has no try around it.
const noEntry = (opts, e, codes) => !!opts && opts.throwIfNoEntry === false && !!e && codes.includes(e.code);
function statSync(p, opts) {
  validatePathArg(p);
  let raw;
  try { raw = FSS.stat(p); } catch (e) { if (noEntry(opts, e, ['ENOENT', 'ENOTDIR'])) return undefined; throw e; }
  return makeStats(raw, opts);
}
function lstatSync(p, opts) {
  validatePathArg(p);
  let raw;
  try { raw = FSS.lstat(p); } catch (e) { if (noEntry(opts, e, ['ENOENT'])) return undefined; throw e; }
  return makeStats(raw, opts);
}

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
  const o = typeof opts === 'object' && opts !== null ? opts : {};
  const fd = openPath(p, o.flag ?? 'a', o.mode);
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
  validatePathArg(prefix, 'prefix');
  for (let attempt = 0; attempt < 16; attempt++) {
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += MKDTEMP_CHARS[Math.floor(Math.random() * MKDTEMP_CHARS.length)];
    const p = prefix + suffix;
    try { FSS.mkdir(p, 0o700); return p; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('node-shim: fs.mkdtempSync exhausted unique-name attempts');
}

function direntFor(parentPath, name) {
  let mode = S_IF.file;
  try { mode = FSS.lstat(path.join(parentPath, name)).mode; } catch { /* broken link etc → treat as file */ }
  return new Dirent(name, mode, parentPath);
}

// A NAME in the caller's encoding (readdir's entries, readlink's target), as node answers: the options' `encoding`
// (a string, or { encoding }), 'utf8' by default; 'buffer' gives a Buffer of the name's bytes; any other Buffer
// encoding re-encodes them. The engine hands names back as strings, so the bytes are the name's UTF-8. Before this,
// encoding was ignored and 'buffer' still got strings: the carve's ExitWorktree vets each registration name with
// `Buffer.from(n.toString('utf8')).equals(n)` and threw on the string, so `action: "remove"` kept the worktree where
// native removed it (every-tool Task 4, 2026-11-20).
function nameEncoding(opts) {
  const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
  return enc === undefined || enc === null ? 'utf8' : enc;
}
function encodeName(name, enc) {
  if (enc === 'utf8' || enc === 'utf-8') return name;
  const b = Buffer.from(name, 'utf8');
  return enc === 'buffer' ? b : b.toString(enc);
}

// Shared readdir core: honours { withFileTypes, recursive, encoding } like host node.
// recursive descends real directories only (lstat kind, no symlink follow);
// without withFileTypes it yields path strings relative to `p` (node's shape).
function readdirCore(p, opts) {
  const wft = !!(opts && opts.withFileTypes);
  const recursive = !!(opts && opts.recursive);
  const enc = nameEncoding(opts);
  const named = (d, n) => { if (enc !== 'utf8' && enc !== 'utf-8') d.name = encodeName(n, enc); return d; };
  // node's readdir is a scandir: its errors say so ("ENOENT: ..., scandir '<p>'")
  const scandir = (d) => { try { return FSS.readdir(d); } catch (e) { throw retold(e, 'scandir', d); } };
  if (!recursive) {
    const names = scandir(p);
    return wft ? names.map((n) => named(direntFor(p, n), n)) : names.map((n) => encodeName(n, enc));
  }
  // breadth-first, as node's recursive readdir is: every entry of a directory, then each subdirectory
  // in the order it was met (measured, node 24.21.0)
  const out = [];
  const queue = [[p, '']];
  while (queue.length) {
    const [dir, relBase] = queue.shift();
    for (const n of scandir(dir)) {
      const rel = relBase ? path.join(relBase, n) : n;
      const d = direntFor(dir, n);
      out.push(wft ? named(d, n) : encodeName(rel, enc));
      if (d.isDirectory()) queue.push([path.join(dir, n), rel]);
    }
  }
  return out;
}

// fs.ReadStream: the concrete class fs.createReadStream() returns (Task 2,
// fd-flavored variants). Previously createReadStream built a bare
// stream.Readable instance with no distinguishing class, so `instanceof
// fs.ReadStream` was false for every real stream it produced — the same trap
// as the FileHandle.chmod gap that broke Edit: a silent else-branch instead of
// a loud error. Extends the shim's real stream.Readable (no lookalike). The
// bundle drives readline.createInterface({input: fs.createReadStream(file)})
// over this for NDJSON/transcript line-scans (19 sites), plus direct data/end
// consumers. Read via tjs.readFile then push in a microtask, so listeners
// attach before the first chunk. Honors {encoding,start,end}.
class ReadStream extends require('node:stream').Readable {
  constructor(p, opts) {
    super({ read() {} });
    const o = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    const start = typeof o.start === 'number' ? o.start : 0;
    const hasEnd = typeof o.end === 'number';
    this.path = p;
    this.close = this.destroy;
    if (o.encoding) this.setEncoding(o.encoding);
    queueMicrotask(async () => {
      try {
        _refuseProcFdOffLinux('open', p, 'r');
        let data = await tjs.readFile(p);
        if (start || hasEnd) data = data.subarray(start, hasEnd ? o.end + 1 : data.length);
        const CH = 65536;
        for (let i = 0; i < data.length; i += CH) this.push(data.subarray(i, Math.min(i + CH, data.length)));
        this.push(null);
      } catch (e) { this.emit('error', e); }
    });
  }
}
function createReadStream(p, opts) { return new ReadStream(p, opts); }

// fs.createWriteStream: a Writable that overwrites ('w') or appends ('a') a file
// (17 sites). {mode} sets the file mode, {start} positions writes. Writes route
// through the sync core (writeAll); the fd is closed on 'finish'/'close'.
function createWriteStream(p, opts) {
  const stream = require('node:stream');
  const o = typeof opts === 'string' ? { encoding: opts } : (opts || {});
  const fd = openPath(p, o.flags || 'w', o.mode);
  let pos = typeof o.start === 'number' ? o.start : null;
  const w = new stream.Writable({
    write(chunk, enc, cb) {
      try {
        const bytes = typeof chunk === 'string' ? encodeStr(chunk, typeof enc === 'string' ? enc : o.encoding) : chunk;
        writeAll(fd, bytes, pos);
        if (pos !== null) pos += bytes.length;
        cb();
      } catch (e) { cb(e); }
    },
  });
  w.path = p;
  let closed = false;
  const closeFd = () => { if (!closed) { closed = true; try { FSS.close(fd); } catch (_) { /* already closed */ } } };
  w.on('finish', closeFd);
  w.on('close', closeFd);
  return w;
}

// fs.cpSync: recursive copy (dir/file/symlink), mirroring promises.rm's recursion.
// Guards against copying a directory onto itself or into a subdirectory of
// itself (host node throws ERR_FS_CP_EINVAL) — otherwise cpDir would recurse
// forever building .../sub/sub/sub until ENAMETOOLONG or a blown stack. The
// check runs once on the public entry, not per recursion.
function cpSync(src, dest, opts = {}) {
  const a = path.resolve(src);
  const b = path.resolve(dest);
  if (a === b) {
    const e = new Error(`src and dest cannot be the same ${a}`);
    e.code = 'ERR_FS_CP_EINVAL';
    throw e;
  }
  if (b.startsWith(a + path.sep)) {
    const e = new Error(`Cannot copy ${a} to a subdirectory of self ${b}`);
    e.code = 'ERR_FS_CP_EINVAL';
    throw e;
  }
  cpDir(src, dest, opts);
}

// Recursive copy worker (no self-recursion guard — the public cpSync vetted the
// roots once). Preserves each source's permission bits, as host node's cp does:
// load-bearing for plugin installs, where a git-subdir plugin's hook scripts are
// checked out 0755 then cpSync'd into the version cache — dropping +x makes the
// SessionStart hook non-executable ("hook error: Permission denied").
function cpDir(src, dest, opts) {
  const st = lstatSync(src);
  if (st.isSymbolicLink && st.isSymbolicLink()) { FSS.symlink(FSS.readlink(src), dest); return; }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const n of FSS.readdir(src)) cpDir(path.join(src, n), path.join(dest, n), opts);
    return;
  }
  writeFileSync(dest, readFileSync(src));
  chmodBestEffort(dest, st.mode & 0o7777);
}

function openDir(p, opts, withPath) {
  // A Dir over an eager Dirent list in the OS's readdir order (the engine's readdir does not sort,
  // as node's Dir does not: test/node-shim-fs-opendir.test.cjs): readSync()/read() hand over the next
  // entry or null, an async iterator, and closeSync()/close(), after which a read is node's
  // ERR_DIR_CLOSED.
  // `encoding` names the entries as readdir's does (a Dirent's name a Buffer for 'buffer'), as node's Dir does.
  // Errors are node's opendir's: syscall opendir, and NO path from opendirSync ("ENOENT: no such file or
  // directory, opendir") but the path from fs.promises.opendir and the callback form (measured, node
  // 24.21.0). { recursive } walks as node's Dir does, breadth-first: the directory's entries, then each
  // subdirectory's in the order met, without following symlinks.
  const listed = (d) => { try { return readdirCore(d, { withFileTypes: true }); } catch (e) { throw retold(e, 'opendir', withPath ? d : undefined); } };
  const ents = listed(p);
  if (opts && opts.recursive) {
    for (let k = 0; k < ents.length; k++) if (ents[k].isDirectory()) ents.push(...listed(path.join(ents[k].parentPath, ents[k].name)));
  }
  const enc = nameEncoding(opts);
  if (enc !== 'utf8' && enc !== 'utf-8') for (const d of ents) d.name = encodeName(d.name, enc);
  let i = 0, closed = false;
  const next = () => {
    if (closed) { const e = new Error('Directory handle was closed'); e.code = 'ERR_DIR_CLOSED'; throw e; }
    return i < ents.length ? ents[i++] : null;
  };
  return {
    path: p,
    readSync: next,
    read: async () => next(),
    close: async () => { closed = true; },
    closeSync: () => { closed = true; },
    [Symbol.asyncIterator]() { return { next: async () => { const e = next(); return e ? { value: e, done: false } : { value: undefined, done: true }; } }; },
  };
}

// fs.utimesSync / fs.lutimesSync: the engine's SYNC utime and lutime (txiki-sync-utime.patch, libuv with no
// callback), so the times are set before the call returns, as node sets them; errors are node's utime /
// lutime ones (retold). Until 2026-11-21 these started the ASYNC tjs.utime and returned, so a stat right
// after one read the old times: the differential saw it under load (test/node-shim-fs-utime-sync.test.cjs
// now sees it in one tick). An engine without the sync calls is REFUSED, by name, never quietly async:
// scripts/engine-api-floor.cjs refuses it at build time, and this refuses the call at run time.
function syncUtime(op, p, atime, mtime) {
  if (typeof FSS[op] !== 'function') {
    const e = new Error(`node-shim: this engine has no synchronous ${op} (it predates txiki-sync-utime.patch), so `
      + `fs.${op}sSync cannot set the times before it returns; rebuild it: ./build.sh --only engine.compile`);
    e.code = 'ERR_CLODE_ENGINE_FLOOR';
    require('../internal/engine-floor-log.cjs').engineFloorLog(e.message);
    throw e;
  }
  try { FSS[op](p, timeToMs(atime), timeToMs(mtime)); } catch (e) { throw retold(e, op, p); }
}
function utimesSync(p, atime, mtime) { syncUtime('utime', p, atime, mtime); }
function lutimesSync(p, atime, mtime) { syncUtime('lutime', p, atime, mtime); }

// fs.fchmodSync(fd, mode): the sync-fs patch (spike/quickjs/patches/txiki-sync-fs.patch)
// has no FSS.fchmod — same gap FileHandle.chmod hit above ("No fd-based fchmod
// primitive exists; chmod the captured path (same inode)"). Reuse that exact
// strategy rather than inventing a second code path: track the path each fd
// was opened with (fsMod.openSync below) and chmod THAT path through the
// already-Windows-safe chmodBestEffort. An fd this map doesn't know about
// (closed, or obtained some other way) fails LOUD — a silent wrong answer here
// is the exact class of trap (bare unnamed quickjs TypeError / false
// `instanceof`) this task exists to close, not reproduce.
//
// KNOWN LIMITATION (documented, not implemented — no bundle-reachable need
// shown): only fds from fs.openSync are on record. Real node's fchmodSync
// accepts ANY valid fd, including a FileHandle's `.fd` from fs.promises.open
// (deliberately exposed below for the Bash-tool stdio-passthrough pattern) —
// that fd is opened via a raw FSS.open call, not fs.openSync, so it never
// enters fdPaths and fchmodSync(handle.fd, mode) throws EBADF here instead of
// succeeding as it would on host node. Not a regression (the shim had no
// fchmodSync at all before this task) and not speculative to fix: there is no
// fd-based chmod primitive in the sync-fs layer regardless of how the fd was
// obtained, so closing this gap for FileHandle fds would need the same
// path-capture trick promises.open already does for FileHandle.chmod — add it
// if/when a real call site needs it, not before.
const fdPaths = new Map();
function fchmodSync(fd, mode) {
  const p = fdPaths.get(fd);
  if (p === undefined) {
    const e = new Error(`node-shim: fs.fchmodSync: fd ${fd} was not opened via fs.openSync (no path on record — closed, or opened another way)`);
    e.code = 'EBADF';
    throw e;
  }
  chmodBestEffort(p, mode);
}

const fsMod = {
  constants,
  readFileSync, writeFileSync, mkdirSync, readSync,
  statSync, lstatSync,
  fstatSync: (fd, opts) => makeStats(FSS.fstat(fd), opts),
  fchmodSync,
  existsSync: (p) => { try { FSS.stat(p); return true; } catch { return false; } },
  realpathSync: (p) => realpathJs(p),
  createReadStream,
  createWriteStream,
  cpSync,
  utimesSync,
  lutimesSync,
  readlinkSync: (p, opts) => encodeName(FSS.readlink(p), nameEncoding(opts)),
  readdirSync: (p, opts) => readdirCore(p, opts),
  opendirSync: (p, opts) => openDir(p, opts, false),
  rmdirSync: (p) => FSS.rmdir(p),
  unlinkSync: (p) => FSS.unlink(p),
  renameSync: (a, b) => renameReplace(a, b),
  accessSync: (p, m) => FSS.access(p, m ?? constants.F_OK),
  // node: openSync(path, flags[, mode]) — mode applies only when the call CREATES (openPath).
  openSync: (p, flags, mode) => {
    const fd = openPath(p, flags ?? 'r', mode);
    fdPaths.set(fd, p);
    return fd;
  },
  // fdPaths cleanup MUST run even when FSS.close throws (e.g. a double-close —
  // a caller bug, but one this codebase already anticipates: createWriteStream's
  // closeFd() below wraps its close in try/catch for exactly "already closed").
  // Without `finally`, a throwing close leaves the entry stale; every OTHER
  // fd-producing path (readFileSync/writeFileSync/appendFileSync/
  // createWriteStream/promises.open/child_process's keychain helpers) opens fds
  // WITHOUT touching fdPaths, so a later reuse of that fd number by one of THOSE
  // paths would leave the map pointing at the OLD path — fchmodSync would then
  // silently chmod the wrong file. That is precisely the class of bug this
  // fd->path map exists to avoid, so the cleanup is unconditional.
  closeSync: (fd) => { try { FSS.close(fd); } finally { fdPaths.delete(fd); } },
  copyFileSync: (a, b) => { writeFileSync(b, readFileSync(a)); chmodBestEffort(b, statSync(a).mode & 0o7777); },
  symlinkSync: (target, p) => FSS.symlink(target, p),
  chmodSync: (p, m) => chmodBestEffort(p, m),
  // fs.truncate/truncateSync: the bundle reaches truncate via fs.promises and
  // FileHandle (below); the sync form has no fd-less primitive in the sync-fs
  // patch, so emulate by read-then-rewrite (shrink slices, extend zero-pads) —
  // Buffer-free (this module runs under the bare loader with no global Buffer).
  truncateSync: (p, len = 0) => {
    const buf = readFileSync(p);
    let out;
    if (buf.length >= len) out = buf.subarray(0, len);
    else { out = new Uint8Array(len); out.set(buf); }
    writeFileSync(p, out);
  },
  truncate: (p, len, cb) => {
    const done = typeof len === 'function' ? len : cb;
    const n = typeof len === 'function' ? 0 : (len ?? 0);
    promises.truncate(p, n).then(() => done && done(null), (e) => done && done(e));
  },
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
    async stat(opts) { return makeStats(FSS.fstat(fd), opts); },
    // FileHandle.readFile: upstream 2.1.251's file reader probes the head of a file for
    // its encoding with a positioned read and then reads the WHOLE thing off the same
    // handle (`o = r === void 0 ? await e.readFile() : …`). Missing this method made every
    // Edit of an existing file report a bare, symbol-less `not a function` as its
    // tool_result while the file on disk stayed untouched — the same shape, and the same
    // class of gap, as FileHandle.chmod below.
    //
    // FROM THE CURRENT POSITION, like node, not from 0: position -1 is what this fd's own
    // read() passes for "wherever the handle is", so a caller that has already consumed
    // part of the handle gets the remainder rather than a second copy of the head. The
    // probe read above passes an explicit position, which (again like node) leaves the
    // handle where it was, so the common shape reads the whole file.
    async readFile(opts) {
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      const chunks = []; let total = 0;
      for (;;) {
        const ab = FSS.read(fd, 1 << 20, -1);
        if (!ab || ab.byteLength === 0) break;
        chunks.push(new Uint8Array(ab)); total += ab.byteLength;
      }
      const data = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { data.set(c, o); o += c.length; }
      if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
      if (isLatin1(enc)) return latin1Decode(data);
      return asBuffer(data);
    },
    // FileHandle.chmod: the bundle's atomic write (Write-overwrite + Edit) writes
    // a temp file then RESTORES the original file's mode via `await handle.chmod`
    // ("Applied original permissions to temp file"). Missing this method made
    // every overwrite/Edit of an existing file throw a bare "not a function"
    // (Write of a NEW file skips it — no original mode to restore). No fd-based
    // fchmod primitive exists; chmod the captured path (same inode).
    async chmod(mode) { chmodBestEffort(p, mode); },
    // FileHandle.truncate: the bundle truncates a FileHandle in file-restore /
    // edit paths (`await fh.truncate(0)` then rewrite). No fd-based ftruncate in
    // the sync-fs patch; tjs's async file handle HAS a real truncate, so open the
    // captured path and truncate that inode (same-inode, like chmod above).
    async truncate(len = 0) { const th = await tjs.open(p, 'r+'); try { await th.truncate(len); } finally { await th.close(); } },
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
    _refuseProcFdOffLinux('open', p, 'r');
    const data = await tjs.readFile(p); // Uint8Array, verified against pinned tjs v26.6.0
    if (enc === 'utf8' || enc === 'utf-8') return td.decode(data);
    if (isLatin1(enc)) return latin1Decode(data);
    return asBuffer(data);
  },
  // opts was dropped here entirely, so the promises form ignored BOTH encoding and
  // mode while the sync form honoured encoding. Thread it.
  writeFile: async (p, data, opts) => { writeFileSync(p, data, opts); },
  utimes: async (p, atime, mtime) => { _refuseProcFdOffLinux('utime', p); await tjs.utime(p, timeToMs(atime), timeToMs(mtime)); },
  lutimes: async (p, atime, mtime) => { _refuseProcFdOffLinux('lutime', p); await tjs.lutime(p, timeToMs(atime), timeToMs(mtime)); },
  // statfs: the bundle CALLS this (not feature-detects it) on its low-disk
  // diagnostic path — `statfs(dir, {bigint:true})`, then
  // `bavail*bsize/(1024n*1024n)` to decide whether to tell the user to free
  // space or set CLAUDE_CODE_TMPDIR. Unimplemented, it was `undefined`, so the
  // call threw a bare "not a function" (quickjs TypeErrors carry no symbol
  // name) INSIDE that path's try/catch — swallowed, so the run still succeeded
  // and the user simply never got the diagnostic. Found by CLODE_SHIM_PROBE
  // during a real-API hunt, not by anything failing.
  //
  // bigint:true is REQUIRED, not optional: the caller does BigInt arithmetic on
  // the result, and mixing BigInt with Number throws TypeError.
  //
  // The engine's tjs.statFs returns node's exact shape MINUS `frsize`; node's
  // frsize is the fragment size, which equals bsize on every platform we ship,
  // so it is mapped from bsize rather than invented.
  statfs: async (p, opts) => {
    _refuseProcFdOffLinux('statfs', p);
    const r = await tjs.statFs(p);
    const big = !!(opts && opts.bigint);
    const n = (v) => (big ? BigInt(Math.trunc(v)) : v);
    return {
      type: n(r.type), bsize: n(r.bsize), frsize: n(r.bsize),
      blocks: n(r.blocks), bfree: n(r.bfree), bavail: n(r.bavail),
      files: n(r.files), ffree: n(r.ffree),
    };
  },
  stat: async (p, opts) => statSync(p, opts),
  lstat: async (p, opts) => makeStats(FSS.lstat(validatePathArg(p)), opts), // ignores throwIfNoEntry, as node's does
  fstat: async (fd, opts) => fsMod.fstatSync(fd, opts),
  mkdir: async (p, opts) => mkdirSync(p, opts),
  readdir: async (p, opts) => readdirCore(p, opts),
  opendir: async (p, opts) => openDir(p, opts, true),
  access: async (p, m) => FSS.access(p, m ?? constants.F_OK),
  realpath: async (p) => FSS.realpath(p),
  readlink: async (p, opts) => encodeName(FSS.readlink(p), nameEncoding(opts)),
  unlink: async (p) => FSS.unlink(p),
  rename: async (a, b) => renameReplace(a, b),
  // fs.promises.truncate(path, len): the bundle shrinks large Bash-output files
  // here. tjs's async file handle exposes a real truncate primitive.
  truncate: async (p, len = 0) => { _refuseProcFdOffLinux('open', p, 'r+'); const th = await tjs.open(p, 'r+'); try { await th.truncate(len); } finally { await th.close(); } },
  rmdir: async (p) => FSS.rmdir(p),
  copyFile: async (a, b) => { writeFileSync(b, readFileSync(a)); chmodBestEffort(b, statSync(a).mode & 0o7777); },
  appendFile: async (p, data, opts) => { appendFileSync(p, data, opts); },
  chmod: async (p, m) => chmodBestEffort(p, m),
  symlink: async (target, p) => FSS.symlink(target, p),
  // hardlink: no SYNC primitive in the sync-fs patch, but tjs exposes an async
  // uv link — use it for the async surface (linkSync remains a wall).
  link: async (existing, p) => { _refuseProcFdOffLinux('link', existing); _refuseProcFdOffLinux('link', p); await tjs.link(existing, p); },
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
  open: async (p, flags, mode) => makeFileHandle(openPath(p, flags ?? 'r', mode), p),
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
// realpathSync.native (4 sites) — same resolution as realpathSync here.
fsMod.realpathSync.native = (p) => FSS.realpath(p);
// KNOWN LIMITATION (documented, not implemented): fs.statfsSync. The engine
// exposes statFs only ASYNC (tjs.statFs) and the sync-fs binding has no statfs
// entry, so a faithful sync form needs an engine patch (libuv's uv_fs_statfs
// supports it). Deliberately left absent rather than faked: the reachable
// caller is the async/promises path above, and a wrong sync answer would be
// worse than a missing one. Revisit if a probe ever shows statfsSync reached.
promises.cp = async (src, dest, opts) => cpSync(src, dest, opts);
fsMod.promises = promises;

// Node's callback fs APIs take an optional options arg before the callback; the
// cb is always last. Route each through its promises twin so behavior matches.
const cbWrap = (pfn) => (...args) => {
  const cb = args.pop();
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  pfn(...args).then((v) => cb(null, v), (e) => cb(e));
};
for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'fstat', 'access', 'readdir',
  'realpath', 'readlink', 'mkdir', 'unlink', 'rename', 'rmdir', 'copyFile', 'rm', 'opendir',
  'utimes', 'lutimes', 'appendFile', 'chmod', 'symlink', 'link', 'mkdtemp', 'fsync', 'fdatasync',
  'statfs']) {
  fsMod[name] = cbWrap(promises[name]);
}
// node's callback realpath is its JS walk (lstat/stat errors), fs.promises.realpath and fs.realpath.native the
// realpath syscall.
fsMod.realpath = cbWrap(async (p) => realpathJs(p));
fsMod.realpath.native = cbWrap(promises.realpath);
// fs.write / fs.read: callback receives (err, bytes, buffer) — extra trailing
// arg beyond cbWrap's (err, val) shape, so wire them explicitly.
// Both validate as node does BEFORE any callback (2.1.330's carve calls fs.write and fs.read): a
// missing or wrong buffer is node's ERR_INVALID_ARG_TYPE, THROWN. Before this `fs.write(fd, cb)`
// wrote the callback, handed its error to a no-op, and called nothing back, and `fs.read(fd, cb)`
// threw "not a function": node reads into a fresh 16384-byte buffer then, and `fs.read(fd, buf,
// cb)` / `fs.read(fd, buf, {offset,length,position}, cb)` are node's too.
const NE = () => require('../internal/node-errors.cjs');
fsMod.write = function write(fd, data, a, b, c, d) {
  // write(fd, buffer[, offset[, length[, position]]], cb) OR
  // write(fd, string[, position[, encoding]], cb)
  NE().validatedFd(fd);
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
    throw NE().invalidArgType('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, or DataView', data);
  }
  const args = [a, b, c, d].filter((x) => typeof x !== 'function');
  const cb = [a, b, c, d].find((x) => typeof x === 'function') || (() => {});
  try {
    const n = typeof data === 'string' ? writeSync(fd, data, args[0], args[1]) : writeSync(fd, data, args[0], args[1], args[2]);
    cb(null, n, data);
  } catch (e) { cb(e); }
};
fsMod.read = function read(fd, buffer, offset, length, position, cb) {
  NE().validatedFd(fd);
  if (typeof buffer === 'function') {                      // read(fd, cb)
    cb = buffer; buffer = Buffer.alloc(16384); offset = 0; length = buffer.byteLength; position = null;
  } else if (buffer && typeof buffer === 'object' && !ArrayBuffer.isView(buffer) && typeof offset === 'function') {
    cb = offset;                                           // read(fd, { buffer, offset, length, position }, cb)
    const o = buffer;
    buffer = o.buffer === undefined ? Buffer.alloc(16384) : o.buffer;
    offset = o.offset === undefined ? 0 : o.offset;
    length = o.length === undefined ? buffer.byteLength - offset : o.length;
    position = o.position === undefined ? null : o.position;
  } else if (typeof offset === 'function') {               // read(fd, buffer, cb)
    cb = offset; offset = 0; length = buffer && buffer.byteLength; position = null;
  } else if (offset && typeof offset === 'object' && typeof length === 'function') {
    cb = length;                                           // read(fd, buffer, { offset, length, position }, cb)
    const o = offset;
    offset = o.offset === undefined ? 0 : o.offset;
    length = o.length === undefined ? buffer.byteLength - offset : o.length;
    position = o.position === undefined ? null : o.position;
  }
  if (typeof cb !== 'function') throw NE().invalidArgType('The "cb" argument must be of type function', cb);
  if (!ArrayBuffer.isView(buffer)) {
    throw NE().invalidArgType('The "buffer" argument must be an instance of Buffer, TypedArray, or DataView', buffer);
  }
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
// fs.open(path[, flags[, mode]], cb): the mode reaches openSync. Until 2026-11-21 it was dropped, so
// `fs.open(p, O_WRONLY|O_APPEND|O_CREAT, 0o600, cb)` (2.1.330 calls it so) created the file 0644 where node
// makes it 0600 (test/node-shim-differential.test.cjs).
fsMod.open = (p, flags, mode, cb) => {
  const c = typeof cb === 'function' ? cb : (typeof mode === 'function' ? mode : flags);
  const fl = typeof flags === 'string' || typeof flags === 'number' ? flags : 'r';
  const md = typeof mode === 'function' ? undefined : mode;
  try { c(null, fsMod.openSync(p, fl, md)); } catch (e) { c(e); }
};
// fdPaths cleanup runs in `finally` (see closeSync's comment) so a throwing
// close still drops the stale entry before the error reaches cb.
// The fd is validated first, as node's getValidatedFd does, and that error is THROWN:
// before this, `fs.close(cb)` (the carve's shape with the fd missing) tried to close the
// callback, caught the engine's error, and then had no callback to give it to, so nothing
// was ever called back (the shim differential's executor waited forever on it).
fsMod.close = (fd, cb) => {
  require('../internal/node-errors.cjs').validatedFd(fd);
  try {
    try { FSS.close(fd); } finally { fdPaths.delete(fd); }
    if (cb) cb(null);
  } catch (e) { if (cb) cb(e); }
};
fsMod.Stats = Stats;
fsMod.Dirent = Dirent;
fsMod.ReadStream = ReadStream;

// fs.watchFile / unwatchFile / watch (Task 4 wall, now a real wall-crossing):
// the -p bundle installs a config-file watcher via `fs.watchFile(path, opts,
// listener)` (its `mLt` helper) at startup. A missing method threw
// `TypeError: not a function` (swallowed to the telemetry logger, but the
// throw still abandoned that init step). watchFile used to register listeners
// but never FIRE 'change' — harmless while every known consumer only read its
// watched file once at startup. That stopped being true: the bundle's
// git-state cache calls `watchFile` on `branchRefPath` (repoWatchers /
// watchedFiles) with a matching `unwatchFile` on teardown, and its accessor is
// `async get(){ for(;;){ let r=this.generation; await this.ensureStarted();
// if (r !== this.generation) return this.value; await new
// Promise(res => watcher.once('change', res)); } }` — the generation counter
// only advances from a fired watcher callback. A stub that never fires left
// that await permanently unresolved: the darwin-ppc "hangs right after
// 'No git remote URL found', no socket/child/threadpool/fetch in flight" wall.
// Node's fs.watchFile is itself POLLING, not inotify/FSEvents (Node's
// StatWatcher stats the path on an interval; see lib/internal/fs/watchers.js)
// — so a genuine implementation here is a straight port of that idea onto the
// facilities this file already has: reuse statSync/Stats (below), do not
// invent a second Stats shape.
const { EventEmitter } = require('node:events');
const TRACE = !!(globalThis.process && globalThis.process.env && globalThis.process.env.CLODE_SHIM_TRACE);
function trace() { if (TRACE) { try { console.error('[watchfile]', ...arguments); } catch { /* best effort */ } } }

// key(String(filename)) -> { handle: EventEmitter, path, interval, prev: Stats|null, timer }
// `prev === null` means "not yet polled" (first sample establishes the
// baseline and must NOT fire, matching Node: a freshly-watched nonexistent
// file doesn't report "still gone" as a change on sample #1).
const _watchers = new Map();

// A watched path that doesn't exist reads back as Node's zeroed Stats
// (mtimeMs === 0 is the tell consumers key off of) rather than throwing.
// Built through the real Stats constructor so every accessor (isFile() etc,
// all false for mode 0) matches a real stat's shape: node's StatWatcher hands
// over an all-zero binding array, so every field is 0, nlink and blksize too.
const _ZERO_RAW = { size: 0, mode: 0, uid: 0, gid: 0, kind: 'other', dev: 0n, ino: 0n, nlink: 0n, rdev: 0n,
  blksize: 0n, blocks: 0n, size64: 0n, atimeSec: 0n, atimeNsec: 0n, mtimeSec: 0n, mtimeNsec: 0n, ctimeSec: 0n,
  ctimeNsec: 0n, birthtimeSec: 0n, birthtimeNsec: 0n };
function _zeroStats() { return new Stats(_ZERO_RAW); }
// Any stat failure (ENOENT or otherwise — permission trouble, a symlink
// loop, an unmounted path) is treated as "currently absent", never thrown:
// this runs on a bare timer callback with no caller try/catch, so a throw
// here would only be reachable via __shimUncaught (or, off `-p`'s
// bundle-installed handler, would kill the process) for what Node treats as
// an ordinary poll sample. Matches libuv's uv_fs_poll, which folds every
// stat() errno into the same "gone" signal. Not the engine-floor refusal: that
// is not a stat errno, and folding it in made every watched file read as
// deleted on a stale engine, with nothing saying why.
function _statOrZero(p) {
  // The poller compares mtimeMs, which an engine without identity cannot report: read it HERE, so
  // that refusal is raised at the stat and not mistaken further on for "the file is gone".
  try { const s = statSync(p); void s.mtimeMs; return s; } catch (e) { if (e && e.code === 'ERR_CLODE_ENGINE_FLOOR') throw e; return _zeroStats(); }
}
function _statsChanged(curr, prev) { return curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size; }

// IMPORTANT DIVERGENCE (deliberate, see fsMod.watchFile below for why): this
// engine exposes NO real per-timer ref/unref to JS — verified against
// spike/quickjs/vendor/txiki.js/src/timers.c (tjs_setTimeout never calls
// uv_unref on the uv_timer_t it creates) and empirically (a bare
// `setInterval(fn, 50)` with nothing else running has to be killed; it never
// lets the process exit). The loader's own setTimeout/setInterval wrapper
// documents `.ref()`/`.unref()` as no-ops for exactly this reason. So a
// literal "call .unref()" would NOT stop our poller from pinning the loop —
// we approximate the OBSERVABLE EFFECT of an unref'd handle instead.
//
// An earlier version of this function asked the engine directly, via the
// libuv handle-walk global the CLODE_SHIM_HANDLE_DUMP/SIGUSR2 diagnostic
// uses (see loader.cjs), and parsed its flat "type/active/ref/closing" text
// lines to guess whether anything else was pinning the loop. That was the
// wrong seam: that global is a DEBUG introspection helper added for hang
// diagnosis, with no stability contract on its text format — production
// control flow must not depend on parsing it. It's replaced below
// with a real, shim-owned signal: loader.cjs's global setTimeout/setInterval
// wrapper is the ONLY place any JS timer is ever created in this process (no
// bypass — every bundle and shim timer call routes through it), so it can
// count them authoritatively itself, exposed as __shimTimerLiveCount(). See
// loader.cjs's "live-timer count" comment for why counting JS timers alone
// is sound: this engine's only *unfixably* always-ref'd JS-facing construct
// is a timer — streams/TLS sockets have real ref()/unref(), fetch/http is
// self-unref'ing via its keepalive, process.on('SIG*') handles are always
// unref'd, and sync child_process never touches the loop — so a non-timer
// handle being genuinely active neither needs nor benefits from our tracking
// it: it keeps the loop alive (or doesn't) correctly on its own regardless of
// what this poller decides. The only way this poller's decision could ever
// cause a HANG is by under-counting other timers; over-counting (this
// poller's own timer bleeding into the total) is the specific failure mode
// __shimRawTimer exists to avoid — see below.
// Residual divergence: once every poller stops itself because nothing else
// was pinning the loop, they stay stopped even if unrelated work starts again
// later (there's no real "wake me if the loop becomes alive again" primitive
// to resume from) — accepted per this task's framing: a `-p` run that fails
// to exit is a worse failure than a watcher that stops working at the point
// the rest of the process was about to end anyway. Also accepted: this only
// sees OTHER JS TIMERS, not e.g. a bare open socket with nothing scheduling a
// timer — a strictly narrower "other work" definition than the old dump-based
// check had, but never an UNSAFE one (see the soundness argument above): the
// poller can now stop a little earlier than it ideally would in some
// non-timer-only workloads, never later than it should.
function _otherWorkPending() {
  const count = globalThis.__shimTimerLiveCount;
  // Missing accessor shouldn't be reachable — loader.cjs installs it before
  // any module (including this one) can load — but if it somehow is, fail
  // toward Node's held-open default rather than guessing wrong in the hang
  // direction, matching the old code's same defensive stance.
  if (typeof count !== 'function') return true;
  return count() > 0;
}
// Raw, uncounted scheduler for this poller's OWN timer (see loader.cjs's
// "escape hatch" comment): using the ordinary wrapped setTimeout here would
// make _otherWorkPending() see this poller's own recurring re-arm as "other"
// work, so it would never observe a truly idle loop.
//
// Resolved LAZILY, at call time, via globalThis PROPERTY ACCESS rather than a
// module-scope constant referencing bare `setTimeout`/`clearTimeout`
// identifiers. Both matter: several tests (win-fs-rename-guard,
// win-shim-guards, node-shim-vm*, extract-hooks) load this module into a bare
// vm.Context with NO timer globals at all — not even a real `setTimeout` —
// purely to exercise unrelated fs surface (renameSync guards, module wiring,
// etc.), and never call fs.watchFile. A module-scope `{ setTimeout,
// clearTimeout }` object-literal fallback evaluates those bare identifiers
// the instant this file is require()'d, and a bare identifier with no
// binding on the scope chain AND no matching global-object property throws
// ReferenceError immediately — crashing module evaluation, and therefore
// every test in the file, over an optional feature (watchFile) those tests
// never touch. `globalThis.setTimeout` is a plain property read: it safely
// evaluates to `undefined` in that same context instead of throwing.
// Deferring the lookup to call time (rather than caching a possibly-absent
// value at load time) also means a poller that could not initially find a
// scheduler still degrades to "never arms" rather than needing to throw.
function _pollerSchedule(fn, delay) {
  const raw = globalThis.__shimRawTimer;
  if (raw && typeof raw.setTimeout === 'function') return raw.setTimeout(fn, delay);
  // __shimRawTimer absent means either an older loader (not the real blobulated
  // path today) or — as above — no loader.cjs ran at all in this host
  // context. Prefer a bare global setTimeout if this context happens to have
  // one (this poller would then count itself in __shimTimerLiveCount, biasing
  // toward "never stop early" — the same safe-direction failure mode
  // documented on _otherWorkPending above, not a hang-causing one); with
  // NEITHER available, there is no way to poll at all — return null rather
  // than throw, and let the caller simply not arm a timer. fs.watchFile still
  // registers and returns its EventEmitter (Node's real contract) in that
  // case; it just never delivers 'change' — no worse than the pre-task-12
  // stub, in a context that couldn't run a poll loop to begin with.
  return typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout(fn, delay) : null;
}
function _pollerCancel(id) {
  if (id == null) return;
  const raw = globalThis.__shimRawTimer;
  if (raw && typeof raw.clearTimeout === 'function') { raw.clearTimeout(id); return; }
  if (typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(id);
}

function _pollOnce(key, ent) {
  ent.timer = null;
  const curr = _statOrZero(ent.path);
  const prev = ent.prev;
  ent.prev = curr;
  if (prev !== null && _statsChanged(curr, prev)) {
    trace('change', key, 'mtimeMs', prev.mtimeMs + '->' + curr.mtimeMs, 'size', prev.size + '->' + curr.size);
    ent.handle.emit('change', curr, prev);
  }
  if (ent.handle.listenerCount('change') === 0) { _watchers.delete(key); return; } // unwatched mid-flight
  if (_otherWorkPending()) {
    ent.timer = _pollerSchedule(() => _pollOnce(key, ent), ent.interval);
  } else {
    trace('idle-stop', key); // see the DIVERGENCE note above _otherWorkPending
  }
}

// fs.watchFile(filename[, options], listener): options is { interval
// (default 5007, Node's own default), persistent }. `persistent` is accepted
// (never throws on it) but has no held-open effect here — see the DIVERGENCE
// note above; this poller never pins the loop regardless of the flag, because
// on this engine "persistent: true done wrong" is a hang, not a nicety.
// Multiple watchFile calls on the same path share ONE poller (Node's real
// contract too: keyed by filename, same StatWatcher instance returned).
fsMod.watchFile = function watchFile(filename, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  options = options || {};
  const key = String(filename);
  let ent = _watchers.get(key);
  if (!ent) {
    const w = new EventEmitter();
    w.ref = () => w; w.unref = () => w; // Node-shaped StatWatcher surface (chained-call idiom)
    const interval = (typeof options.interval === 'number' && options.interval > 0) ? options.interval : 5007;
    ent = { handle: w, path: key, interval, prev: null, timer: null };
    _watchers.set(key, ent);
    trace('watch', key, 'interval=' + interval);
  }
  if (typeof listener === 'function') ent.handle.on('change', listener);
  // (Re-)arm if idle: covers both brand-new watchers and one that had self-
  // stopped (see _otherWorkPending) but just gained a fresh registration.
  if (ent.timer == null) ent.timer = _pollerSchedule(() => _pollOnce(key, ent), 0);
  return ent.handle;
};
fsMod.unwatchFile = function unwatchFile(filename, listener) {
  const key = String(filename);
  const ent = _watchers.get(key);
  if (!ent) return;
  if (typeof listener === 'function') ent.handle.removeListener('change', listener);
  else ent.handle.removeAllListeners('change');
  trace('unwatch', key, 'remaining=' + ent.handle.listenerCount('change'));
  if (ent.handle.listenerCount('change') === 0) {
    _pollerCancel(ent.timer); // must actually clear: a leaked interval is its own hang
    _watchers.delete(key);
  }
};
// fs.watch (the inotify/FSEvents-style API): STILL a stub, unlike watchFile
// above. Left alone deliberately, but NOT because nothing calls it — an earlier
// version of this comment claimed "the bundle has 0 call sites for fs.watch",
// which was simply wrong. Verified against the pinned 2.1.218 bundle
// (2026-08-01): FOUR `<alias>.watch(` call sites where the alias is
// `require("fs")`, and only ONE of them is the vendored chokidar the wall
// tripwire's rationale assumes. The other three are FIRST-PARTY Claude Code:
//   - jobStateNameSync   — watches a state dir, ignores non-`state.json` names
//   - useBgSessionPr     — same shape, background-session React hook
//   - an unref'd watcher in a private-field class whose `catch {}` is EMPTY
// All three swallow errors, so a stub that returns a never-firing EventEmitter
// is indistinguishable from a working watcher that sees no changes: they degrade
// SILENTLY, exactly like the fs.watchFile stub did before it cost a day on
// darwin-ppc. What keeps this a wall rather than a live bug is reachability —
// those paths are believed off clode's supported (-p / interactive) routes — and
// that belief is UNVERIFIED. See test/fidelity/RECIPE.md row C7.
// Why still a stub: this engine's uv_fs_event backend is ENOSYS on some legs, so
// there is no portable native primitive to poll-emulate cheaply the way
// watchFile's plain stat diff does. Emulating it means a recursive stat walk.
fsMod.watch = function watch(filename, options, listener) {
  if (typeof options === 'function') { listener = options; }
  const w = new EventEmitter();
  w.close = () => {};
  w.ref = () => w; w.unref = () => w;
  if (typeof listener === 'function') w.on('change', listener);
  return w;
};

module.exports = fsMod;

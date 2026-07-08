'use strict';
// isTerminal detection (found empirically, not in the original design):
// merely READING tjs.stdout.isTerminal / tjs.stderr.isTerminal / tjs.stdin.
// isTerminal lazily constructs tjs's async libuv-backed stream wrapper for
// that fd, which as a side effect puts the underlying fd into O_NONBLOCK.
// That breaks the writeSyncFd short-write-loop's blocking assumption for the
// (far more common) non-TTY case — a large payload over a pipe whose kernel
// buffer fills mid-write then throws EUNKNOWN instead of blocking. Confirmed
// via a minimal repro: `void tjs.stdout;` alone, with no other change, makes
// a >64KB process.stdout.write over a pipe fail the same way.
// __tjs_fs_sync.fstat(fd) is a plain synchronous stat(2)/fstat(2) call with
// no such side effect, so decide terminal-ness from the raw POSIX mode bits
// (S_ISCHR) instead. Only once we already know fd IS a real terminal should
// callers touch tjs.stdout/tjs.stderr/tjs.stdin (e.g. inside tty.WriteStream,
// for width/height, or tty.ReadStream, for the keystroke pump).
//
// Shared by modules/process.cjs (stdout/stderr/stdin construction) and
// modules/tty.cjs (isatty) so this mode-bit logic lives in exactly one place
// — see the tty.cjs regression this fixed: isatty(fd) used to read
// tjs.stdin/stdout/stderr directly, which flipped fd 1 to O_NONBLOCK as a
// side effect of merely being CALLED (e.g. by chalk/supports-color at module
// load on the -p path), corrupting later large writes on that same fd.
const S_IFMT = 0o170000;
const S_IFCHR = 0o020000;
function isTerminalFd(fd) {
  try { return (globalThis.__tjs_fs_sync.fstat(fd).mode & S_IFMT) === S_IFCHR; } catch { return false; }
}
module.exports = { isTerminalFd, S_IFMT, S_IFCHR };

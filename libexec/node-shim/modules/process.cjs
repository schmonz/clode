'use strict';
// node:process — M1 surface. Extended in Task 5 (nextTick, hrtime, stdio
// flush fix, on/off registry, umask, argv0).
//
// tjs API notes (verified empirically against the pinned tjs v26.6.0
// binary; see libexec/node-shim/loader.cjs header for the full writeup):
//   - tjs.cwd, tjs.exePath, tjs.pid are already-evaluated VALUES, not
//     functions (unlike the brief's tjs.cwd()/tjs.exit() draft assumed for
//     cwd/exePath/pid — exit() genuinely is a function).
//   - tjs.platform does not exist on the global; navigator.platform
//     ('MacIntel' / 'Linux x86_64' / 'Win32' / ...) is the real signal.
//   - tjs has no arch signal in this build; hardcoded 'arm64' below.
//     M4 (NetBSD/mac68k guest) must revisit this.
//
// stdout/stderr writes: Task-3 used tjs.stdout.getWriter().write(...) and
// never awaited the returned promise — a write() immediately followed by
// process.exit() could lose bytes. Confirmed empirically (RED: writing
// 'flushed-bytes' then exit(0) produced empty captured stdout). Fixed here
// via Task 1's __tjs_fs_sync.write(fd, ArrayBuffer, position): fd 1/2 are
// stdout/stderr, and position < 0 makes the C side call write(2) (a real
// synchronous syscall, not pwrite — works on pipes/ttys/files alike),
// matching node's synchronous process.stdout.write contract. Verified
// against a real pipe: the test harness captures stdout via spawnSync,
// which is a pipe, and the flush test (test/node-shim-core.test.cjs) goes
// green with this approach. The getWriter machinery is dropped entirely.
// console.log is tjs-native and untouched by this change.
const te = new TextEncoder();
const FSS = globalThis.__tjs_fs_sync;

function detectPlatform() {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Mac/.test(np)) return 'darwin';
  if (/^Win/.test(np)) return 'win32';
  if (/^Linux/.test(np)) return 'linux';
  if (/FreeBSD/i.test(np)) return 'freebsd';
  if (/OpenBSD/i.test(np)) return 'openbsd';
  return 'linux';
}

function writeSync(fd, s) {
  const bytes = te.encode(String(s));
  let off = 0;
  // POSIX write(2) on a blocking pipe may do a SHORT write for large
  // payloads — loop until every byte lands or the carry-forward "must not
  // lose bytes" goal is silently violated for big stdout/stderr output.
  while (off < bytes.length) {
    const chunk = off === 0 ? bytes.buffer : bytes.buffer.slice(off);
    const n = FSS.write(fd, chunk, -1);
    if (n <= 0) throw new Error('node-shim: stdio write failed');
    off += n;
  }
  return true;
}
function writeOut(s) { return writeSync(1, s); }
function writeErr(s) { return writeSync(2, s); }

module.exports = {
  argv: [],                                  // loader overwrites after load
  argv0: 'tjs',
  env: new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? tjs.env[k] : undefined),
    has: (_, k) => typeof k === 'string' && k in tjs.env,
    ownKeys: () => Reflect.ownKeys(tjs.env),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }),
  platform: detectPlatform(),
  arch: 'arm64', // M4: derive per-platform (no arch signal in this tjs build)
  pid: tjs.pid,
  execPath: tjs.exePath ?? '/tjs',
  cwd: () => tjs.cwd,
  exit: (c) => tjs.exit(c ?? 0),
  exitCode: 0,
  versions: { node: '24.0.0-node-shim-m1' },
  stdout: { write: writeOut, isTTY: false },
  stderr: { write: writeErr, isTTY: false },
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  hrtime: Object.assign(
    () => { const ms = performance.now(); return [Math.floor(ms / 1e3), Math.floor((ms % 1e3) * 1e6)]; },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  // Event registry: signals/exit are M2+ concerns (tjs.signal exists per the
  // gate-2 matrix); M1 records handlers without wiring delivery — loudly.
  on(name, fn) { (this.__handlers ??= []).push([name, fn]); return this; },
  off() { return this; },
  umask: () => 0o022,
};

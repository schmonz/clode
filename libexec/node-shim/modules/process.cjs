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
const { writeSyncFd } = require('../internal/stdio-write.cjs');
const { isTerminalFd } = require('../internal/terminal-fd.cjs');

function detectPlatform() {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Mac/.test(np)) return 'darwin';
  if (/^Win/.test(np)) return 'win32';
  if (/^Linux/.test(np)) return 'linux';
  if (/FreeBSD/i.test(np)) return 'freebsd';
  if (/OpenBSD/i.test(np)) return 'openbsd';
  return 'linux';
}

function writeSync(fd, s) { return writeSyncFd(fd, s); }
function writeOut(s) {
  if (tjs.env.CLODE_SHIM_DEBUG) { try { writeSync(2, `[shim] stdout.write(${JSON.stringify(String(s)).slice(0, 120)})\n`); } catch { /* ignore */ } }
  return writeSync(1, s);
}
function writeErr(s) { return writeSync(2, s); }

// process.stdin (Task 4 wall): the -p boot reads `process.stdin.isTTY` during
// startup. Node's process.stdin is a Readable tied to fd 0; here it is a real
// node-shim Readable (node:stream) carrying isTTY/fd and the paused-mode control
// methods the bundle feature-detects. DIVERGENCE: it never pushes bytes from
// the real fd 0 — `-p` takes its prompt from argv and does not consume stdin, so
// no async fd-0 pump is wired (adding one is a future wall if a stdin-reading
// path is ever driven). Built lazily so node:stream loads after the global
// process is installed. Cached for stable EventEmitter identity.
// process.stdout / process.stderr (Task 4 wall): the -p boot registers an
// 'error' handler on both (stdout.on('error', ...)) and may read .columns/.rows,
// so they must be EventEmitter-backed Writable-like streams, not the plain
// { write, isTTY } objects. write() STAYS synchronous (writeSync over fd 1/2 —
// the flush-before-exit contract the core tests lock); only the EventEmitter
// surface is added. Built lazily so node:events loads after the global process
// is installed; cached for stable identity.
let _stdout, _stderr;
function makeWriteStream(fd, writeFn) {
  const { EventEmitter } = require('node:events');
  const s = new EventEmitter();
  s.fd = fd;
  s.isTTY = false;
  s.writable = true;
  s.columns = undefined;   // non-tty: no known width (bundle defaults, e.g. 80)
  s.rows = undefined;
  s.write = function (chunk, enc, cb) {
    writeFn(chunk);
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  s.end = function (chunk, enc, cb) {
    if (chunk != null && typeof chunk !== 'function') writeFn(chunk);
    const done = typeof chunk === 'function' ? chunk : (typeof enc === 'function' ? enc : cb);
    if (typeof done === 'function') done();
    this.emit('finish');
    return this;
  };
  s.cork = function () {};
  s.uncork = function () {};
  s.destroy = function () { return this; };
  s.setDefaultEncoding = function () { return this; };
  return s;
}
// isTerminal detection: see internal/terminal-fd.cjs for the empirically-found
// O_NONBLOCK side-effect writeup (reading tjs.stdout/tjs.stderr/tjs.stdin has
// it; __tjs_fs_sync.fstat(fd) does not). isTerminalFd is shared with
// modules/tty.cjs's isatty() so the mode-bit logic lives in one place.
function makeStdout(fd, writeFn, isTerminal) {
  if (isTerminal) {
    const tty = require('node:tty');
    return new tty.WriteStream(fd);
  }
  return makeWriteStream(fd, writeFn);   // unchanged non-TTY path
}
function getStdout() { return _stdout || (_stdout = makeStdout(1, writeOut, isTerminalFd(1))); }
function getStderr() { return _stderr || (_stderr = makeStdout(2, writeErr, isTerminalFd(2))); }

let _stdin;
function getStdin() {
  if (_stdin) return _stdin;
  // Terminal-ness decided via isTerminalFd (fstat S_IFCHR), NOT tjs.stdin.isTerminal:
  // reading tjs.stdin lazily constructs tjs's async libuv stream wrapper and flips
  // fd 0 to O_NONBLOCK as a side effect (same quirk as stdout/stderr above), which
  // would break the non-TTY path's blocking-read assumption. Only the TTY branch
  // below (which needs tjs.stdin.getReader() for the pump) may touch tjs.stdin.
  if (isTerminalFd(0)) {
    const tty = require('node:tty');
    _stdin = new tty.ReadStream(0);
    return _stdin;
  }
  const { Readable } = require('node:stream');
  const s = new Readable({ read() {} });
  s.isTTY = undefined;   // piped/non-tty stdin, matching host node (undefined)
  s.fd = 0;
  s.isRaw = false;
  s.setRawMode = function (m) { this.isRaw = !!m; return this; };
  s.setEncoding = function (e) { this._enc = e; return this; };
  s.resume = function () { return this; };
  s.pause = function () { return this; };
  s.ref = function () { return this; };
  s.unref = function () { return this; };
  _stdin = s;
  return s;
}

module.exports = {
  argv: [],                                  // loader overwrites after load
  argv0: 'tjs',
  // process.execArgv (Task 4 wall): Node runtime flags before the script. The
  // -p boot does process.execArgv.some(...) to detect debug/inspect flags; under
  // tjs there are none, so an empty array (matching a plain invocation).
  execArgv: [],
  // process.env: reads/writes/deletes proxy through to tjs.env (which the
  // runtime mirrors into the real environment, so spawned children inherit a
  // write — Node semantics, characterized by test/node-shim-env.test.cjs).
  // The set/deleteProperty traps and `writable: true` are load-bearing: without
  // them an env assignment silently no-ops in sloppy mode and THROWS
  // ("'X' is read-only") in strict mode — and the fused quaude runs the bundle
  // as compiled-module bytecode, which is always strict. Node stringifies on
  // write (String(v)); delete of a missing key is a no-op returning true.
  env: new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? tjs.env[k] : undefined),
    set: (_, k, v) => { if (typeof k === 'string') { try { tjs.env[k] = String(v); } catch { /* setenv failure -> Node throws only on invalid names; swallow */ } } return true; },
    deleteProperty: (_, k) => { if (typeof k === 'string') { try { delete tjs.env[k]; } catch { /* ignore */ } } return true; },
    has: (_, k) => typeof k === 'string' && k in tjs.env,
    ownKeys: () => Reflect.ownKeys(tjs.env),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, writable: true }),
  }),
  platform: detectPlatform(),
  arch: 'arm64', // M4: derive per-platform (no arch signal in this tjs build)
  pid: tjs.pid,
  execPath: tjs.exePath ?? '/tjs',
  cwd: () => tjs.cwd,
  exit(c) {
    if (tjs.env.CLODE_SHIM_DEBUG) {
      try { writeErr(`[shim] process.exit(${c}) called\n${new Error().stack}\n`); } catch { /* ignore */ }
    }
    return tjs.exit(c ?? this.exitCode ?? 0);
  },
  // process.kill(pid, signal='SIGTERM') over the __tjs_kill primitive
  // (mod_spawn_sync.c): raw kill(2), so signal 0 (the liveness probe the
  // bundle's background-task supervision leans on), negative pids (process
  // groups — the Ctrl-Z suspend path is `process.kill(0,"SIGTSTP")`), and
  // both name and number signals all behave like node. Node returns true on
  // success and throws {code:'ESRCH'|'EPERM'} on failure — the primitive's
  // errors already carry that shape. Without this, the suspend path printed
  // "has been suspended" then died on a swallowed TypeError and never
  // stopped. Characterized by test/node-shim-signals.test.cjs.
  kill(pid, sig) {
    const k = globalThis.__tjs_kill;
    if (typeof k !== 'function') {
      throw new Error('node-shim: process.kill needs __tjs_kill (rebuild tjs with txiki-sync-spawn.patch)');
    }
    k(pid, sig ?? 'SIGTERM');
    return true;
  },
  // process.exitCode defaults to UNDEFINED in Node (a code is only present once
  // set), NOT 0. The -p bundle guards `if (process.exitCode !== undefined) {
  // /* graceful shutdown */ return }` right after startup — a default of 0 makes
  // that guard fire and silently ABORTS the action before the Messages
  // round-trip. exit() already falls back through `?? 0`, so undefined is safe.
  // Characterized by test/node-shim-core.test.cjs (process.exitCode default row).
  exitCode: undefined,
  // process.version (Task 4 wall): the boot gates on
  // process.version.match(/^v(\d+)\./) >= 22. A 'v'-prefixed semver string, kept
  // in step with versions.node (the shim presents as a Node 24 host).
  version: 'v24.0.0',
  versions: { node: '24.0.0-node-shim-m1' },
  get stdout() { return getStdout(); },
  get stderr() { return getStderr(); },
  get stdin() { return getStdin(); },
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  // process.uptime() (Task 4 wall): seconds since process start. performance.now()
  // is ms since the runtime time-origin (process start), so /1000 is the uptime.
  uptime: () => performance.now() / 1000,
  hrtime: Object.assign(
    () => { const ms = performance.now(); return [Math.floor(ms / 1e3), Math.floor((ms % 1e3) * 1e6)]; },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  // process.memoryUsage() (tjs tool-use wall): the bundle's tool runner ($Ty)
  // calls `process.memoryUsage()` immediately before EVERY tool's e.call() to
  // capture an rss/heap/external baseline for the tengu_tool_use_success
  // analytics delta (and again after, computing re.rss-X.rss etc.). tjs exposes
  // NO memory API — no tjs.gc/rss/resourceUsage, verified against the pinned
  // binary — so without this the property is undefined and the call throws
  // TypeError "not a function". QuickJS collapses that throw onto the async $Ty
  // frame (stack top is just `$Ty`, no deeper frame), so it surfaces to the
  // model as "Error calling tool (X): not a function" and EVERY agentic tool
  // call fails before the tool ever runs. Node's contract: returns
  // {rss,heapTotal,heapUsed,external,arrayBuffers} in bytes, and memoryUsage.rss
  // is itself a fast-path function returning the rss number. We have no real
  // figures, so report zeros: the only consumers are analytics deltas, which
  // stay well-defined at 0 (and h9m()'s rss/statm divide is darwin-guarded to a
  // 4096 fallback). Locked by test/node-shim-core.test.cjs.
  memoryUsage: Object.assign(
    () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    { rss: () => 0 },
  ),
  // process.cpuUsage() — used on the adjacent event-loop-stall diagnostics path
  // (`cpu:process.cpuUsage()` alongside memoryUsage.rss()); tjs has no CPU
  // accounting. Node returns cumulative {user,system} microseconds; zeros keep
  // any prev-relative delta well-defined.
  cpuUsage: () => ({ user: 0, system: 0 }),
  // Event registry: process EventEmitter surface (Task 4 wall): the -p boot
  // registers handlers and calls process.removeAllListeners('warning'). A real
  // registry over __handlers backs on/once/off/removeListener/
  // removeAllListeners/emit/listeners.
  // Signal DELIVERY is wired: the first listener for a SIG* name arms a
  // tjs.addSignalListener dispatcher (the API tty.cjs already uses for
  // SIGWINCH; the uv_signal handle is unref'd inside tjs, so an armed signal
  // never pins the event loop or blocks natural exit), and the last removal
  // disarms it. The Ctrl-Z resume path depends on this: after
  // process.kill(0,"SIGTSTP") stops the group, `fg` sends SIGCONT and the
  // bundle's process.on("SIGCONT") handler must actually fire to re-enter raw
  // mode and repaint. SIGKILL/SIGSTOP are uncatchable; arming failures fall
  // back to registry-only (registration still works, delivery loudly absent
  // under CLODE_SHIM_DEBUG). Characterized by test/node-shim-signals.test.cjs.
  // DIVERGENCE: 'exit' delivery is still not wired (tjs.exit does not run
  // handlers). The -p path registers then removes handlers (it does not depend
  // on 'exit' delivery to flush output — its writes go straight through
  // process.stdout.write/writeSync). Wire it test-first if a future path
  // depends on it.
  __wireSignal(name) {
    if (typeof name !== 'string' || !/^SIG[A-Z0-9]+$/.test(name)) return;
    if (name === 'SIGKILL' || name === 'SIGSTOP') return;   // uncatchable
    const wired = (this.__sigWired ??= new Map());
    if (wired.has(name)) return;
    const dispatch = () => { this.emit(name, name); };       // node passes the signal name
    try {
      tjs.addSignalListener(name, dispatch);
      wired.set(name, dispatch);
    } catch (e) {
      if (tjs.env.CLODE_SHIM_DEBUG) { try { writeErr(`[shim] signal ${name} not wireable: ${e?.message}\n`); } catch { /* ignore */ } }
    }
  },
  __unwireSignalIfIdle(name) {
    const wired = this.__sigWired;
    if (!wired || !wired.has(name)) return;
    if (this.listenerCount(name) > 0) return;
    try { tjs.removeSignalListener(name, wired.get(name)); } catch { /* ignore */ }
    wired.delete(name);
  },
  on(name, fn) {
    if (tjs.env.CLODE_SHIM_DEBUG) { try { writeErr(`[shim] process.on(${name}) registered\n`); } catch { /* ignore */ } }
    (this.__handlers ??= []).push({ name, fn, once: false });
    this.__wireSignal(name);
    return this;
  },
  once(name, fn) { (this.__handlers ??= []).push({ name, fn, once: true }); this.__wireSignal(name); return this; },
  addListener(name, fn) { return this.on(name, fn); },
  prependListener(name, fn) { (this.__handlers ??= []).unshift({ name, fn, once: false }); this.__wireSignal(name); return this; },
  removeListener(name, fn) {
    if (this.__handlers) this.__handlers = this.__handlers.filter((h) => !(h.name === name && h.fn === fn));
    this.__unwireSignalIfIdle(name);
    return this;
  },
  off(name, fn) { return this.removeListener(name, fn); },
  removeAllListeners(name) {
    if (!this.__handlers) return this;
    this.__handlers = name === undefined ? [] : this.__handlers.filter((h) => h.name !== name);
    if (name === undefined) { for (const n of [...(this.__sigWired?.keys() ?? [])]) this.__unwireSignalIfIdle(n); }
    else this.__unwireSignalIfIdle(name);
    return this;
  },
  listeners(name) { return (this.__handlers || []).filter((h) => h.name === name).map((h) => h.fn); },
  listenerCount(name) { return (this.__handlers || []).filter((h) => h.name === name).length; },
  emit(name, ...args) {
    const hs = (this.__handlers || []).filter((h) => h.name === name);
    if (hs.length === 0) return false;
    for (const h of hs) { if (h.once) this.removeListener(name, h.fn); h.fn.apply(this, args); }
    return true;
  },
  emitWarning() { return undefined; },
  umask: () => 0o022,
};

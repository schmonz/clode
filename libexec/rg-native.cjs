'use strict';
// rg-native.cjs — quaude's rg. Every rg the bundle spawns is answered HERE, never by a
// host ripgrep.
//
// WHY QUAUDE HAS ITS OWN rg (memory rg-divergence-is-intentional, host-applets-config-is-
// foundational). rg is Rust and cannot run everywhere quaude does (NetBSD/sparc, Tiger PPC,
// Haiku); ugrep can. So quaude answers rg with ugrep, ON PURPOSE, and "install ripgrep" is
// never the remedy. Native Claude Code embeds its own rg; this module is what stands in for
// it, and the goal is native's answer byte for byte (test/fidelity/rg-differential.test.cjs
// judges exactly that, against native's embedded rg).
//
// SHAPE. bun-shim.cjs routes every spawn surface the bundle can reach rg through here
// (child_process execFile/execFileSync/spawn/spawnSync — node-shim's under quaude, node's
// under naude — and Bun.spawn/Bun.spawnSync), matching the executable by BASENAME (isRgExe),
// so `/opt/pkg/bin/rg` (what Bun.which answers when an rg is installed) and a bare `rg` are
// the same call. No rg process ever starts. The ASYNC surfaces get rgSpawn/rgExecFile: the
// applet quaude answers rg with runs as a real asynchronous child behind a child of node's
// shape, so the event loop keeps turning, the caller's stdin reaches it, and the caller's
// signal, kill(), timeout and maxBuffer end it. The SYNC surfaces get runRg (blocking, as
// theirs do in node) through rgSpawnSync/rgExecFileSync. A refusal is a child that started
// no process at all.
//
// FOR NOW (the plan's Task 4) both delegate to today's rg -> ugrep translation, which
// bun-shim owns and passes in (`translate`), and run the applet it names. The emulation
// proper (walk and match over ugrep, rg's printers, JSON Lines, binary rules, ignore rules,
// globs, types) replaces that delegation rule by rule, each rule measured from native.
//
// Loaded by bun-shim.cjs as `require(__dirname + '/rg-native.cjs')`, so it travels beside
// bun-shim.cjs in every packaging (test/shim-companions.test.cjs). CommonJS under tjs and
// under node alike; it requires only node builtins.
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Is this executable rg? By BASENAME, never by the exact string `rg`: the bundle resolves
// rg as `Bun.which('rg') ?? 'rg'`, which is an absolute path whenever the host has an rg
// installed, and matching only `rg` let that host rg answer every Grep and Glob call
// (measured 2026-09-27, report-grep.md). On Windows Bun.which answers whichever PATHEXT
// spelling it found (`rg.exe`, or a `rg.cmd`/`rg.bat` shim a package manager installed), so
// every one of those is rg too, in any case.
function isRgExe(file) {
  if (typeof file !== 'string' || file === '') return false;
  return /^rg(?:\.(?:exe|com|bat|cmd))?$/i.test(leafOf(file));
}

// An executable's leaf name. ONE rule on every platform (test/windows-path-ratchet.test.cjs's
// slash-only-pathedness): a win32 path may be C:\x\rg.exe, a\rg or C:rg, so both separators
// and a drive prefix end the directory part everywhere. On a POSIX host that also reads a
// file literally named `a\rg` as rg, which only ever refuses more, never runs a host rg.
function leafOf(file) {
  return String(file).split(/[\\/]/).pop().replace(/^[A-Za-z]:/, '');
}

// THE HONEST REFUSAL: a failed child, rc 2, nothing on stdout, the flag and the reason on
// stderr. Used whenever quaude's rg cannot give native's answer; it never falls through to a
// host rg and never tells anyone to install ripgrep.
//
// THE SPELLING IS LOAD-BEARING. `rg: error parsing flag <flag>: <reason>` is native rg's own
// spelling of a usage error (2.1.283's embedded ripgrep 14.1.1 prints `rg: error parsing flag
// --max-columns: value is not a valid number: ...`), and it is one of the five spellings
// upstream's Grep/Glob consumer shows the model as an error ("Search failed ... ripgrep
// rejected the pattern, glob, or file type without searching:" plus this stderr; `oX` and its
// usage-error regex `TQ` in 2.1.283's chunk-9yjanq6m.js). Every other rc 2 with no output,
// that consumer reads as "no results", which is exactly the silent wrong answer ("No files
// found") this replaces. test/build-gates/rg-probe-gates.test.cjs reads that regex from the
// pinned carve, by structure, and requires this spelling to pass it.
//
// REFUSAL_LINE is this spelling, stated ONCE: rgRefusal writes it and parseRgRefusal reads it
// back (the tests and the differential's tally read refusals only through it).
const REFUSAL_LINE = /^rg: error parsing flag(?: (\S+))?: (.*)$/m;
function rgRefusal(reason, { flag } = {}) {
  const line = `rg: error parsing flag${flag ? ' ' + flag : ''}: ${reason}\n`;
  return { stdout: Buffer.alloc(0), stderr: Buffer.from(line, 'utf8'), status: 2, signal: null, refused: reason };
}
// A refusal of quaude's rg in some text (its stderr, or a tool_result quoting it):
// { flag, reason }, flag null when the refusal names none; null when the text holds none.
// Only quaude's own reasons count: native's real usage errors share the prefix.
function parseRgRefusal(text) {
  const m = REFUSAL_LINE.exec(String(text == null ? '' : text));
  return m && /quaude answers rg/.test(m[2]) ? { flag: m[1] || null, reason: m[2] } : null;
}

// Output a synthesized child may hold. rg's own output has no limit; this bounds what a sync
// run may buffer when the caller named none (execFile names its maxBuffer, 20 MB in 2.1.283).
const RG_MAX_BUFFER = 256 * 1024 * 1024;

const toBuf = (b) => (b == null ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : Buffer.from(b));
const firstLine = (buf) => toBuf(buf).toString('utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';

// What an applet run comes to when the applet could not be run at all (ENOENT, EACCES, ...):
// a refusal naming the applet, never a fall-through to anything else.
function couldNotRun(bin, e) {
  return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, could not be run `
    + `(${(e && (e.code || e.message)) || 'unknown error'}); nothing was searched`);
}

// What an applet that exited >= 2 having printed NOTHING comes to: it rejected the translated
// search, so quaude's rg refuses, naming what the applet said. `onRejected(argv, status)` lets
// the caller surface it to the operator as well.
function appletRejected(bin, status, stderr) {
  const said = firstLine(stderr);
  return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, rejected this search`
    + `${said ? ` (${said})` : ` (exit ${status})`}; nothing was found`);
}

// THE SYNCHRONOUS RUN, for the synchronous surfaces only (spawnSync, execFileSync): they block
// their caller by contract, as node's do. Every other surface runs the applet asynchronously
// (rgSpawn below), so the event loop keeps turning and the caller's bounds can end the search.
//
// argv: rg's arguments (no argv[0]). opts:
//   cwd, env              where and with what the search runs (env defaults to process.env)
//   input                 what the caller hands the child's stdin (rg reads it for target `-`)
//   timeout, maxBuffer,   the caller's own bounds, when it named them
//   killSignal
//   translate(argv)       -> { argv: [applet, ...] } or { refuse, flag } — today's translation
//   spawnSync             the UNWRAPPED spawnSync to run the applet with
//   onRejected(argv, st)  told when the applet rejected the translation
// Returns { stdout, stderr, status, signal }, plus `refused` for a refusal and `errorCode` when
// a bound fired (node's spawnSync reports ETIMEDOUT / ENOBUFS; node-shim's ETIMEDOUT for both).
function runRg(argv, opts = {}) {
  const t = opts.translate(argv);
  if (t.refuse) return rgRefusal(t.refuse, { flag: t.flag });
  const [bin, ...rest] = t.argv;
  const r = opts.spawnSync(bin, rest, {
    cwd: opts.cwd, env: opts.env || process.env, encoding: 'buffer',
    // Bytes, always: the run itself is encoding 'buffer', which node will not decode a string with.
    input: typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input,
    killSignal: opts.killSignal,
    timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : undefined,
    maxBuffer: typeof opts.maxBuffer === 'number' ? opts.maxBuffer : RG_MAX_BUFFER,
  });
  const stdout = toBuf(r.stdout), stderr = toBuf(r.stderr);
  const code = r.error && r.error.code;
  // A bound fired: the caller's own timeout or maxBuffer killed the run, which is what it would
  // see from rg too, so it is reported the way node reports it, not as a refusal.
  if (code === 'ETIMEDOUT' || code === 'ENOBUFS') {
    return { stdout, stderr, status: null, signal: r.signal || opts.killSignal || 'SIGTERM', errorCode: code };
  }
  if (r.error) return couldNotRun(bin, r.error);
  if (r.status >= 2 && stdout.length === 0) {
    if (opts.onRejected) opts.onRejected(t.argv, r.status);
    return appletRejected(bin, r.status, stderr);
  }
  return { stdout, stderr, status: r.status, signal: r.signal || null };
}

// ---- the children the async surfaces get ----------------------------------------------------
// node's stdio slots: 'pipe' (the default) gets a stream; anything else does not.
function stdioSlots(opts) {
  const s = opts && opts.stdio;
  const one = (i) => (Array.isArray(s) ? (s[i] === undefined || s[i] === null ? 'pipe' : s[i]) : (s || 'pipe'));
  return [one(0), one(1), one(2)];
}
function abortError(signal) {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError'; e.code = 'ABORT_ERR';
  if (signal && signal.reason !== undefined) e.cause = signal.reason;
  return e;
}
function endedWritable() {
  const w = new EventEmitter();
  w.writable = false; w.destroyed = false;
  w.write = () => false;
  w.end = (chunk, enc, cb) => {
    const f = [chunk, enc, cb].find((x) => typeof x === 'function');
    if (f) queueMicrotask(f);
    return w;
  };
  w.destroy = () => { w.destroyed = true; return w; };
  w.cork = () => {}; w.uncork = () => {}; w.setDefaultEncoding = () => w;
  return w;
}
const toFd = (fd, buf) => { if (buf.length) { try { (fd === 1 ? process.stdout : process.stderr).write(buf); } catch { /* closed */ } } };

// The child shape both kinds share: streams per slot, kill, and the bounds node's spawn honours
// (`signal`: an 'error' carrying an AbortError, then the kill; `timeout`: the kill). `kill(sig)`
// is how each kind ends its run. finish({ status, signal, stderr }) ends the child: the
// streams end, then 'exit', then 'close' — the order a real child's listeners rely on.
function childShell(opts, kill) {
  const [, outSlot, errSlot] = stdioSlots(opts);
  const child = new EventEmitter();
  child.stdout = outSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.stderr = errSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.exitCode = null; child.signalCode = null; child.killed = false;
  let done = false, timer = null, unlisten = null;
  child.kill = (sig) => { if (done) return false; child.killed = true; return kill(sig || 'SIGTERM'); };
  child.ref = () => child; child.unref = () => child;
  const out = (buf) => { if (child.stdout) { if (buf.length) child.stdout.push(buf); } else if (outSlot === 'inherit') toFd(1, buf); };
  const finish = ({ status, signal, stderr }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // node's spawn takes its 'abort' listener off when the child ends. The 2.1.283 Grep tool
    // hands every rg the SAME tool-context signal, so one left behind per search (holding its
    // child and the stdout it buffered) would grow with every search of a session.
    if (unlisten) { unlisten(); unlisten = null; }
    if (child.stdout) child.stdout.push(null);
    const err = toBuf(stderr);
    if (child.stderr) { if (err.length) child.stderr.push(err); child.stderr.push(null); } else if (errSlot === 'inherit') toFd(2, err);
    child.exitCode = status; child.signalCode = signal || null;
    child.emit('exit', status, signal || null);
    setTimeout(() => child.emit('close', status, signal || null), 0);
  };
  const killSignal = opts.killSignal || 'SIGTERM';
  if (typeof opts.timeout === 'number' && opts.timeout > 0) timer = setTimeout(() => child.kill(killSignal), opts.timeout);
  const signal = opts.signal;
  if (signal) {
    const onAbort = () => { if (done) return; child.kill(killSignal); child.emit('error', abortError(signal)); };
    if (signal.aborted) process.nextTick(onAbort);
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => signal.removeEventListener('abort', onAbort);
    }
  }
  return { child, out, finish, isDone: () => done };
}

// A child that never started a process: a refusal, answered on the next turn of the loop (the
// caller attaches its listeners first, as with a real child). Killed or aborted first, it ends
// with that signal instead.
function refusedChild(r, opts) {
  let killedWith = null, sh = null;
  sh = childShell(opts, (sig) => { killedWith = sig; setTimeout(() => sh.finish({ status: null, signal: sig, stderr: null }), 0); return true; });
  const { child } = sh;
  child.pid = undefined;                    // no process was started
  child.stdin = stdioSlots(opts)[0] === 'pipe' ? endedWritable() : null;
  setTimeout(() => {
    if (sh.isDone()) return;
    child.emit('spawn');
    if (killedWith) return;
    sh.out(toBuf(r.stdout));
    sh.finish(r);
  }, 0);
  return child;
}

// child_process.spawn (and Bun.spawn, which bun-shim builds on it): the applet runs as a REAL
// asynchronous child, with the caller's stdin wired straight to it (the bundle pipes a
// task-output file into rg's stdin for target `-`). Its stdout streams through as it arrives; its
// stderr is held until it exits, because an applet that exits >= 2 having printed nothing has
// rejected the translation and its stderr becomes quaude's refusal. ctx:
//   translate(argv)       today's translation (see runRg)
//   spawn                 the UNWRAPPED asynchronous spawn
//   onRejected(argv, st)  told when the applet rejected the translation
function rgSpawn(argv, opts = {}, ctx) {
  const t = ctx.translate(argv);
  if (t.refuse) return refusedChild(rgRefusal(t.refuse, { flag: t.flag }), opts);
  const [bin, ...rest] = t.argv;
  const inSlot = stdioSlots(opts)[0];
  let applet;
  try {
    applet = ctx.spawn(bin, rest, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: opts.windowsHide,
      stdio: [inSlot === 'pipe' ? 'pipe' : inSlot, 'pipe', 'pipe'] });
  } catch (e) { return refusedChild(couldNotRun(bin, e), opts); }
  const sh = childShell(opts, (sig) => { try { return applet.kill(sig); } catch { return false; } });
  const { child } = sh;
  child.pid = applet.pid;
  child.stdin = applet.stdin || null;
  if (child.stdin) child.stdin.on('error', () => {});   // a search that ends early closes its stdin
  let printed = 0;
  const errs = [];
  applet.stdout.on('data', (d) => { printed += d.length; sh.out(toBuf(d)); });
  applet.stderr.on('data', (d) => { errs.push(toBuf(d)); });
  applet.on('spawn', () => { child.pid = applet.pid; child.emit('spawn'); });
  applet.on('error', (e) => { if (!sh.isDone() && !child.killed) { const r = couldNotRun(bin, e); sh.finish(r); } });
  applet.on('close', (code, signal) => {
    const stderr = Buffer.concat(errs);
    if (code >= 2 && printed === 0 && !child.killed) {
      if (ctx.onRejected) ctx.onRejected(t.argv, code);
      sh.finish(appletRejected(bin, code, stderr));
      return;
    }
    sh.finish({ status: code, signal, stderr });
  });
  return child;
}

// child_process.execFile: the child, plus (err, stdout, stderr) once it closes, with node's
// fields: an AbortError for an abort; for the maxBuffer bound (node's default 1 MiB), the child
// killed and ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which the 2.1.283 Grep/Glob consumer reads as
// "output passed the limit" (a plain kill it reads as "timed out"); otherwise code, or
// killed + signal, and cmd.
function rgExecFile(argv, opts, cb, file, ctx) {
  const o = opts || {};
  const enc = o.encoding === undefined ? 'utf8' : o.encoding;
  const conv = (b) => (enc === 'buffer' || enc === null ? b : b.toString(enc));
  const maxBuffer = typeof o.maxBuffer === 'number' ? o.maxBuffer : 1024 * 1024;
  const child = rgSpawn(argv, { ...o, stdio: 'pipe' }, ctx);
  const outs = [], errs = [];
  let outLen = 0, errLen = 0, overflow = null, aborted = null;
  child.stdout.on('data', (d) => {
    outLen += d.length; outs.push(d);
    if (outLen > maxBuffer && !overflow) { overflow = 'stdout'; child.kill(o.killSignal || 'SIGTERM'); }
  });
  child.stderr.on('data', (d) => {
    errLen += d.length; errs.push(d);
    if (errLen > maxBuffer && !overflow) { overflow = 'stderr'; child.kill(o.killSignal || 'SIGTERM'); }
  });
  child.on('error', (e) => { aborted = e; });
  child.on('close', (code, signal) => {
    if (typeof cb !== 'function') return;
    const so = Buffer.concat(outs).subarray(0, maxBuffer), se = Buffer.concat(errs).subarray(0, maxBuffer);
    const stdout = conv(so), stderr = conv(se);
    if (aborted) { cb(aborted, stdout, stderr); return; }
    const cmd = [file, ...argv].join(' ');
    if (overflow) {
      const e = new RangeError(`${overflow} maxBuffer length exceeded`);
      e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'; e.cmd = cmd;
      cb(e, stdout, stderr); return;
    }
    if (code === 0) { cb(null, stdout, stderr); return; }
    const err = new Error(`Command failed: ${cmd}\n${se.toString('utf8')}`);
    err.code = code; err.killed = child.killed && signal != null; err.signal = signal; err.cmd = cmd;
    cb(err, stdout, stderr);
  });
  return child;
}

// child_process.spawnSync, node's result shape.
function rgSpawnSync(r, opts = {}) {
  const enc = opts.encoding;
  const conv = (b) => ((enc && enc !== 'buffer') ? toBuf(b).toString(enc) : toBuf(b));
  const [, outSlot, errSlot] = stdioSlots(opts);
  const slot = (s, b, fd) => {
    if (s === 'pipe') return conv(b);
    if (s === 'inherit') toFd(fd, toBuf(b));
    return null;
  };
  const stdout = slot(outSlot, r.stdout, 1), stderr = slot(errSlot, r.stderr, 2);
  const out = { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal || null };
  if (r.errorCode) out.error = Object.assign(new Error(`spawnSync rg ${r.errorCode}`), { code: r.errorCode, errno: r.errorCode, syscall: 'spawnSync rg' });
  return out;
}

// child_process.execFileSync: stdout, or a throw carrying node's fields.
function rgExecFileSync(r, opts, file, args) {
  const s = rgSpawnSync(r, opts || {});
  if (s.error) throw s.error;
  if (s.status !== 0) {
    const cmd = [file, ...(args || [])].join(' ');
    const e = new Error(`Command failed: ${cmd}\n${toBuf(r.stderr).toString('utf8')}`);
    Object.assign(e, { status: s.status, signal: s.signal, stdout: s.stdout, stderr: s.stderr, output: s.output, pid: 0 });
    throw e;
  }
  return s.stdout;
}

module.exports = { isRgExe, rgRefusal, parseRgRefusal, runRg, rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync, RG_MAX_BUFFER };

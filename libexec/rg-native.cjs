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
// SHAPE. runRg(argv, opts) -> { stdout: Buffer, stderr: Buffer, status, signal } is the one
// entry point. bun-shim.cjs routes every spawn surface the bundle can reach rg through to it
// (child_process execFile/execFileSync/spawn/spawnSync — node-shim's under quaude, node's
// under naude — and Bun.spawn/Bun.spawnSync), matching the executable by BASENAME (isRgExe),
// so `/opt/pkg/bin/rg` (what Bun.which answers when an rg is installed) and a bare `rg` are
// the same call. The surfaces then hand the caller a SYNTHESIZED child carrying runRg's
// result (rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync): no rg process ever starts.
//
// FOR NOW (the plan's Task 4) runRg delegates to today's rg -> ugrep translation, which
// bun-shim owns and passes in (`opts.translate`), and runs the applet it names. The
// emulation proper (walk and match over ugrep, rg's printers, JSON Lines, binary rules,
// ignore rules, globs, types) replaces that delegation rule by rule, each rule measured from
// native.
//
// Loaded by bun-shim.cjs as `require(__dirname + '/rg-native.cjs')`, so it travels beside
// bun-shim.cjs in every packaging (test/shim-companions.test.cjs). CommonJS under tjs and
// under node alike; it requires only node builtins.
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Is this executable rg? By BASENAME, never by the exact string `rg`: the bundle resolves
// rg as `Bun.which('rg') ?? 'rg'`, which is an absolute path whenever the host has an rg
// installed, and matching only `rg` let that host rg answer every Grep and Glob call
// (measured 2026-09-27, report-grep.md). `rg.exe` is how Bun.which spells it on Windows.
function isRgExe(file) {
  if (typeof file !== 'string' || file === '') return false;
  const leaf = leafOf(file);
  return leaf === 'rg' || leaf.toLowerCase() === 'rg.exe';
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
// found") this replaces. test/rg-spawn.test.cjs pins the spelling against that regex.
function rgRefusal(reason, { flag } = {}) {
  const line = `rg: error parsing flag${flag ? ' ' + flag : ''}: ${reason}\n`;
  return { stdout: Buffer.alloc(0), stderr: Buffer.from(line, 'utf8'), status: 2, signal: null, refused: reason };
}

// Output a synthesized child may hold. rg's own output has no limit; this bounds what a sync
// run may buffer when the caller named none (execFile names its maxBuffer, 20 MB in 2.1.283).
const RG_MAX_BUFFER = 256 * 1024 * 1024;

const toBuf = (b) => (b == null ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : Buffer.from(b));
const firstLine = (buf) => toBuf(buf).toString('utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';

// argv: rg's arguments (no argv[0]). opts:
//   cwd, env              where and with what the search runs (env defaults to process.env)
//   timeout, maxBuffer    the caller's own bounds, when it named them
//   translate(argv)       -> { argv: [applet, ...] } or { refuse, flag } — today's translation
//   spawnSync             the UNWRAPPED spawnSync to run the applet with
// Returns { stdout, stderr, status, signal }. A refusal additionally carries `refused`; a
// result whose applet rejected the translation carries `appletRejected: { argv, status }`
// so the caller can surface that to the operator as well.
function runRg(argv, opts = {}) {
  const t = opts.translate(argv);
  if (t.refuse) return rgRefusal(t.refuse, { flag: t.flag });
  const [bin, ...rest] = t.argv;
  const r = opts.spawnSync(bin, rest, {
    cwd: opts.cwd, env: opts.env || process.env, encoding: 'buffer',
    timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : undefined,
    maxBuffer: typeof opts.maxBuffer === 'number' ? opts.maxBuffer : RG_MAX_BUFFER,
  });
  const stdout = toBuf(r.stdout), stderr = toBuf(r.stderr);
  const code = r.error && r.error.code;
  // Killed for running too long or printing too much: the caller's own bound fired, which is
  // what it would see from rg too. node reports ETIMEDOUT/ENOBUFS with the kill signal;
  // node-shim's spawnSync reports both as ETIMEDOUT with SIGKILL.
  if (code === 'ETIMEDOUT' || code === 'ENOBUFS') return { stdout, stderr, status: null, signal: r.signal || 'SIGKILL' };
  if (r.error) {
    return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, could not be run `
      + `(${code || r.error.message}); nothing was searched`);
  }
  if (r.status >= 2 && stdout.length === 0) {
    const said = firstLine(stderr);
    return { ...rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, rejected this search`
      + `${said ? ` (${said})` : ` (exit ${r.status})`}; nothing was found`),
    appletRejected: { argv: t.argv, status: r.status } };
  }
  return { stdout, stderr, status: r.status, signal: r.signal || null };
}

// ---- the synthesized children --------------------------------------------------------------
// Each surface's result shape, as node gives it, carrying runRg's answer. `run` is a thunk
// (() => result) so the async surfaces can run it AFTER returning the child: a caller attaches
// its listeners to what spawn()/execFile() returned before anything is emitted, as with a real
// child. The run itself is synchronous.

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

// The async child (child_process.spawn). Emits 'spawn', then the output, then 'exit' and,
// once the output has been delivered, 'close' — the order a real child's listeners rely on.
function rgSpawn(run, opts = {}) {
  const [inSlot, outSlot, errSlot] = stdioSlots(opts);
  const child = new EventEmitter();
  child.pid = undefined;                    // no process was started
  child.stdin = inSlot === 'pipe' ? endedWritable() : null;
  child.stdout = outSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.stderr = errSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.exitCode = null; child.signalCode = null; child.killed = false;
  let done = false, killedWith = null;
  child.kill = (sig) => { if (done) return false; child.killed = true; killedWith = sig || 'SIGTERM'; return true; };
  child.ref = () => child; child.unref = () => child;
  const finish = (r) => {
    done = true;
    const deliver = (stream, slot, buf, fd) => {
      if (stream) { if (buf.length) stream.push(buf); stream.push(null); }
      else if (slot === 'inherit' && buf.length) { try { (fd === 1 ? process.stdout : process.stderr).write(buf); } catch { /* closed */ } }
    };
    deliver(child.stdout, outSlot, toBuf(r.stdout), 1);
    deliver(child.stderr, errSlot, toBuf(r.stderr), 2);
    child.exitCode = r.status; child.signalCode = r.signal || null;
    child.emit('exit', r.status, r.signal || null);
    setTimeout(() => child.emit('close', r.status, r.signal || null), 0);
  };
  setTimeout(() => {
    const signal = opts.signal;
    if (signal && signal.aborted) {
      done = true;
      child.emit('error', abortError(signal));
      finish({ stdout: null, stderr: null, status: null, signal: 'SIGTERM' });
      return;
    }
    child.emit('spawn');
    if (killedWith) { finish({ stdout: null, stderr: null, status: null, signal: killedWith }); return; }
    let r;
    try { r = run(); } catch (e) { r = rgRefusal(`quaude's rg failed: ${e && e.message ? e.message : e}`); }
    finish(r);
  }, 0);
  return child;
}

// child_process.execFile: the child, plus (err, stdout, stderr) once it closes. err carries
// node's fields: code (the exit code) or killed+signal, and cmd.
function rgExecFile(run, opts, cb, file, args) {
  const o = opts || {};
  const enc = o.encoding === undefined ? 'utf8' : o.encoding;
  const conv = (b) => (enc === 'buffer' || enc === null ? toBuf(b) : toBuf(b).toString(enc));
  let result = null;
  const child = rgSpawn(() => (result = run()), { ...o, stdio: 'pipe' });
  let aborted = null;
  child.on('error', (e) => { aborted = e; });
  child.on('close', (code, signal) => {
    if (typeof cb !== 'function') return;
    const r = result || { stdout: null, stderr: null };
    const stdout = conv(r.stdout), stderr = conv(r.stderr);
    if (aborted) { cb(aborted, stdout, stderr); return; }
    if (code === 0) { cb(null, stdout, stderr); return; }
    const cmd = [file, ...(args || [])].join(' ');
    const err = new Error(`Command failed: ${cmd}\n${toBuf(r.stderr).toString('utf8')}`);
    err.code = code; err.killed = signal != null; err.signal = signal; err.cmd = cmd;
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
    if (s === 'inherit' && toBuf(b).length) { try { (fd === 1 ? process.stdout : process.stderr).write(toBuf(b)); } catch { /* closed */ } }
    return null;
  };
  const stdout = slot(outSlot, r.stdout, 1), stderr = slot(errSlot, r.stderr, 2);
  const out = { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal || null };
  if (r.status === null && r.signal) out.error = Object.assign(new Error('spawnSync rg ETIMEDOUT'), { code: 'ETIMEDOUT', errno: 'ETIMEDOUT' });
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

module.exports = { isRgExe, rgRefusal, runRg, rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync, RG_MAX_BUFFER };

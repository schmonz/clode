'use strict';
// node:child_process over tjs.spawn. M3 surface: the spawn/spawnSync/execFile/
// exec family bun-shim patches and the bundle's -p path calls. UNSEALED — a
// genuinely missing method is Node's undefined idiom; only a CALL of an
// unimplemented one walls. Characterized by test/node-shim-child-process.test.cjs.
//
// tjs.spawn PROBED against the pinned tjs binary (build/tjs/tjs eval), NOT
// documented upstream:
//   tjs.spawn(argvArray, { cwd, env, stdin, stdout, stderr }) -> a process
//   object with .pid (number), .stdin/.stdout/.stderr (WHATWG Writable/
//   Readable streams — present only for opts that request 'pipe'; omitted
//   opts leave them undefined and the child inherits the parent's fd),
//   .kill(signal), and .wait() -> Promise<{ exit_status:number,
//   term_signal:number|null }>. Confirmed via:
//     tjs eval 'const p=tjs.spawn(["/bin/echo","hi"],{stdout:"pipe"});
//       console.log(Object.keys(p), typeof p.wait)'   -> [] (getters on the
//       prototype, not own props), "function"
//     tjs eval '...; p.wait().then(s=>console.log(JSON.stringify(s)))'
//       -> {"exit_status":0,"term_signal":null}
//     tjs eval '...; p.stdout.getReader().read()...'  -> WHATWG reader works
//   This matches the brief's assumed shape closely enough that Steps 3-4 did
//   not need restructuring — three real divergences did surface, noted below
//   and at each call site:
//
//   DIVERGENCE A (ENOENT is a SYNCHRONOUS throw, not a wait()-rejection):
//   `tjs.spawn(["/no/such/bin"], {...})` THROWS immediately — a real Error
//   with .code === 'ENOENT' and .message === 'ENOENT: no such file or
//   directory' (and NO .errno — probed undefined) — instead of returning a
//   process whose wait() later rejects. Host node's cp.spawn, by contrast,
//   NEVER throws synchronously for a launch failure; it emits, asynchronously,
//   BOTH 'error' THEN 'close' — and does NOT fire 'exit' (verified against host
//   node v24.18.0: `cp.spawn('/no/such/x')` with both listeners logs
//   [['error','ENOENT'],['close',-2,null]], no throw, no 'exit'). The 'close'
//   args are (code, signal) = (-2, null): -2 is -errno for ENOENT, signal
//   null. spawn() below wraps the tjs.spawn() call in try/catch and defers
//   BOTH a queued 'error' AND 'close' emit (in that order) so the shim matches
//   node's full launch-failure contract — emitting 'error' alone would silently
//   hang a caller using the (more common) 'close'-listener lifecycle idiom.
//
//   DIVERGENCE B (no synchronous event-loop pump exists in this tjs build) —
//   RESOLVED on darwin/linux by a C primitive, `__tjs_spawn_sync` (the
//   `txiki-sync-spawn.patch`, mirroring the sync-fs patch's shape): a
//   posix_spawn + poll()-drain that blocks the calling (main) thread until
//   the child exits or a timeout/maxBuffer cap fires, then returns
//   `{pid,status,signal,stdout,stderr,timedOut}` synchronously. spawnSync
//   below calls it directly; no event-loop pump was needed after all. Before
//   landing on the C route, a Worker+Atomics spike (spawn the child inside a
//   Worker, Atomics.wait() on the main thread for a SharedArrayBuffer flag)
//   was tried and REJECTED: Atomics.wait() throws "cannot block in this
//   thread" when called from the tjs main thread (only worker threads may
//   block on it), so that approach could not actually synchronize without
//   itself becoming new unproven surface. The C primitive avoids that
//   entirely — it blocks in C, not JS — which is why it was chosen instead.
//   execFileSync/execSync are built on spawnSync and inherit the real
//   behavior for free; bun-shim's `spawn.sync` (which calls `cp.spawnSync`)
//   lights up unchanged.
//
//   DIVERGENCE C (writing to a piped child's stdin did not complete in probe):
//   `tjs.spawn(["/bin/cat"], {stdin:'pipe', stdout:'pipe'})` then
//   `p.stdin.getWriter().write(...)` never resolved in a direct probe (traced
//   to the WritableStream controller's `_started:false` — the stream's start
//   algorithm appears not to run without something already pulling). No test
//   in this repo writes to a child's stdin yet, so `child.stdin` below is
//   exposed as a best-effort passthrough only (per the brief's own note) —
//   extend test-first if a real call site needs it.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const FSS = globalThis.__tjs_fs_sync;

// Opt-in spawn tracing (CLODE_SHIM_TRACE=1) — diagnostic for the -p wall-walk;
// silent unless enabled. Writes to stderr so it never pollutes the -p stdout.
const TRACE = !!(globalThis.process && globalThis.process.env && globalThis.process.env.CLODE_SHIM_TRACE);
function trace() { if (TRACE) { try { console.error('[cp]', ...arguments); } catch { /* best effort */ } } }

function resolveExe(file, env) {
  // Node resolves a bare command via PATH for spawn; a path with a slash is used
  // as-is. Mirror that so a bundle spawn of a bare tool behaves like node.
  if (file.includes('/')) return file;
  for (const dir of String((env && env.PATH) || process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, file);
    try { if (FSS.stat(p).kind === 'file') return p; } catch { /* keep looking */ }
  }
  return file; // let tjs.spawn surface the ENOENT
}

function normStdio(opts) {
  const s = opts.stdio;
  const one = (i, def) => Array.isArray(s) ? (s[i] ?? def) : (s ?? def);
  return {
    stdin: one(0, 'pipe') === 'inherit' ? 'inherit' : 'pipe',
    stdout: one(1, 'pipe') === 'inherit' ? 'inherit' : 'pipe',
    stderr: one(2, 'pipe') === 'inherit' ? 'inherit' : 'pipe',
  };
}

// Node-shaped launch error: spawn ENOENT never throws synchronously in node —
// it surfaces as an Error with .code/.syscall/.path/.spawnargs on an 'error'
// event (async) or as spawnSync's `.error` field (sync). Build that shape from
// whatever tjs.spawn threw synchronously (see DIVERGENCE A above).
function launchError(err, syscall, file, args) {
  const e = new Error(`${syscall} ${file} ${(err && err.code) || 'UNKNOWN'}`);
  e.code = (err && err.code) || 'UNKNOWN';
  e.errno = err && err.errno;
  e.syscall = syscall;
  e.path = file;
  e.spawnargs = args;
  return e;
}

// Node reports a child's terminating signal as its STRING name ("SIGKILL",
// "SIGTERM"), not the raw OS number. The C primitive __tjs_spawn_sync returns
// the low-level number (it's the syscall layer); translate here. Built lazily
// (first-wins on any number collision, e.g. SIGABRT/SIGIOT) off the same
// os.constants.signals table node uses, so the mapping tracks the platform.
let _signalNames;
function signalName(n) {
  if (n == null || n === 0) return null;
  if (!_signalNames) {
    _signalNames = {};
    const sig = (require('node:os').constants && require('node:os').constants.signals) || {};
    for (const name of Object.keys(sig)) {
      const num = sig[name];
      if (!(num in _signalNames)) _signalNames[num] = name;
    }
  }
  return _signalNames[n] || null;
}

// Node's `shell` option: when truthy, the command is run through a shell rather
// than executed directly. Node builds a single command string ("file arg1 arg2")
// and invokes `<shell> -c "<command>"` (shell defaults to /bin/sh on unix; a
// string value names the shell). The -p bundle uses this for `ps aux | grep …`
// (a pipeline) and the `"…/run-hook.cmd" session-start` session hook — both are
// single command strings with an empty args array. Mirror node so those spawns
// run instead of ENOENT-ing on a literal "ps aux | grep …" path.
function applyShell(file, args, opts) {
  if (!opts || !opts.shell) return { file, args };
  const shellExe = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
  const command = (args && args.length) ? [file, ...args].join(' ') : String(file);
  return { file: shellExe, args: ['-c', command] };
}

function spawn(file, args = [], opts = {}) {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  const env = opts.env || undefined;
  const stdio = normStdio(opts);
  ({ file, args } = applyShell(file, args, opts));
  trace('spawn', file, JSON.stringify(args), 'stdio=', JSON.stringify(stdio));
  const child = new EventEmitter();
  let proc;
  try {
    proc = tjs.spawn([resolveExe(file, env || process.env), ...args], {
      cwd: opts.cwd, env, stdin: stdio.stdin, stdout: stdio.stdout, stderr: stdio.stderr,
    });
  } catch (err) {
    // DIVERGENCE A: tjs.spawn throws sync on ENOENT; node emits the failure
    // asynchronously instead. On a launch failure host node (v24.18.0,
    // verified) fires BOTH 'error' THEN 'close' — and does NOT fire 'exit'.
    // The 'close' args are (code, signal) = (-2, null): code -2 is -errno for
    // ENOENT (node's own value), signal null. We MUST emit 'close' too, else a
    // caller using the (more common) 'close'-listener lifecycle idiom after a
    // failed spawn waits forever — a silent hang the fail-loud standard forbids.
    child.pid = undefined;
    child.stdout = null; child.stderr = null; child.stdin = null;
    child.kill = () => false;
    child.ref = () => {}; child.unref = () => {};
    const closeCode = typeof err.errno === 'number' ? err.errno : -2; // -errno (ENOENT -> -2)
    queueMicrotask(() => {
      child.emit('error', launchError(err, 'spawn', file, args));
      child.emit('close', closeCode, null);
    });
    return child;
  }
  child.pid = proc.pid;
  // Wrap tjs WHATWG streams as node-ish EventEmitters emitting 'data'/'end'.
  const wrapReadable = (s, which) => {
    if (!s) return null;
    const em = new EventEmitter();
    em.readable = true;
    em.destroyed = false;
    // .destroy() — the bundle's execa-style stream cleanup (get-stream's `Q2n`)
    // calls stdout/stderr.destroy() on the error path; a missing method throws
    // `TypeError: not a function` and aborts that cleanup. Node's destroy marks
    // destroyed and emits 'close'; idempotent. Cancels the reader so the drain
    // loop stops.
    em.destroy = (err) => {
      if (em.destroyed) return em;
      em.destroyed = true;
      try { em._reader && em._reader.cancel(); } catch { /* already closed */ }
      queueMicrotask(() => { if (err) em.emit('error', err); em.emit('close'); });
      return em;
    };
    em.pause = () => em; em.resume = () => em;
    (async () => {
      try {
        const reader = s.getReader();
        em._reader = reader;
        for (;;) {
          if (em.destroyed) break;
          const { value, done } = await reader.read();
          if (done) break;
          if (value) em.emit('data', Buffer.from(value));
        }
        trace('stream end', file, which);
        em.emit('end');
      } catch (e) { trace('stream error', file, which, String(e)); em.emit('error', e); }
    })();
    return em;
  };
  child.stdout = wrapReadable(proc.stdout, 'stdout');
  child.stderr = wrapReadable(proc.stderr, 'stderr');
  child.stdin = proc.stdin || null; // DIVERGENCE C: best-effort passthrough only
  // Some callers (execa-style cleanup) call child.stdin.destroy(); guard it.
  if (child.stdin && typeof child.stdin.destroy !== 'function') {
    child.stdin.destroy = () => { try { child.stdin.close && child.stdin.close(); } catch { /* ignore */ } };
  }
  child.kill = (sig) => { try { proc.kill(sig); return true; } catch { return false; } };
  child.ref = () => {}; child.unref = () => {};
  proc.wait().then(
    (st) => { trace('wait resolved', file, 'exit=', st.exit_status); child.exitCode = st.exit_status; child.emit('exit', st.exit_status, st.term_signal || null); child.emit('close', st.exit_status, st.term_signal || null); },
    (e) => { trace('wait rejected', file, String(e)); child.emit('error', e); },
  );
  return child;
}

// spawnSync: real synchronous spawn over the C primitive __tjs_spawn_sync
// (posix_spawn + poll drain; DIVERGENCE B resolved on darwin — see header).
// Node result shape; encoding/toString + PATH resolution + shell done here.
function spawnSync(file, args = [], opts = {}) {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  ({ file, args } = applyShell(file, args, opts));
  trace('spawnSync', file, JSON.stringify(args));
  if (typeof globalThis.__tjs_spawn_sync !== 'function') {
    throw new Error('node-shim: child_process.spawnSync needs __tjs_spawn_sync (rebuild tjs with txiki-sync-spawn.patch — see child_process.cjs header)');
  }
  const env = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined;
  let input;
  if (opts.input != null) {
    const b = Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(String(opts.input));
    // pass a real ArrayBuffer slice (the C side reads an ArrayBuffer)
    input = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const exe = resolveExe(file, (opts.env && opts.env.PATH) ? opts.env : process.env);
  let r;
  try {
    r = globalThis.__tjs_spawn_sync(exe, args, {
      cwd: opts.cwd, env, input,
      timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : 0,
      // Match node's real spawnSync default (1 MiB) exactly — no divergence.
      maxBuffer: typeof opts.maxBuffer === 'number' ? opts.maxBuffer : (1024 * 1024),
    });
  } catch (err) {
    // DIVERGENCE: launch failure — the C op THROWS a coded Error; node's
    // spawnSync instead RETURNS an object with .error set and status null.
    // Reshape to node's EXACT launch-failure contract (verified against host
    // node v26 for a bad path): pid 0, status/signal null, stdout/stderr
    // undefined (the keys exist but are unset — NOT empty buffers/strings),
    // output null, error set. Callers that read r.error/r.status work.
    const e = launchError(err, 'spawnSync', exe, args);
    return { pid: 0, status: null, signal: null, error: e,
             stdout: undefined, stderr: undefined, output: null };
  }
  const enc = opts.encoding;
  const conv = (ab) => {
    const buf = Buffer.from(ab);
    return (enc && enc !== 'buffer') ? buf.toString(enc) : buf;
  };
  const out = conv(r.stdout), err = conv(r.stderr);
  const result = {
    pid: r.pid,
    status: r.status,
    // Node exposes the terminating signal by NAME, not the raw OS number.
    signal: signalName(r.signal),
    stdout: out, stderr: err, output: [null, out, err],
  };
  // DIVERGENCE: node sets result.error on timeout/maxBuffer; mirror the timeout
  // case. The C primitive conflates a maxBuffer overrun with a real timeout —
  // BOTH are reported via the same `timedOut:true` flag (both SIGKILL the
  // child; see mod_spawn_sync.c's DIVERGENCE comment). This shim therefore
  // CANNOT distinguish "output exceeded maxBuffer" from "ran too long"; both
  // surface as this single ETIMEDOUT-shaped error rather than node's
  // maxBuffer-specific RangeError (ERR_CHILD_PROCESS_STDIO_MAXBUFFER).
  // Additionally, on timeout the C always kills with SIGKILL, so result.signal
  // reads "SIGKILL" where node's timeout default is "SIGTERM" (documented in
  // mod_spawn_sync.c). Not fabricating a separate maxBuffer path is intentional
  // (YAGNI): the bundle's sync callers pass maxBuffer:1e6 for a keychain read
  // and won't exceed it. Both divergences are characterized (tjs-only rows) in
  // test/node-shim-child-process.test.cjs.
  if (r.timedOut) result.error = Object.assign(new Error(`spawnSync ${exe} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: 'ETIMEDOUT' });
  return result;
}

function execFile(file, args, opts, cb) {
  if (typeof args === 'function') { cb = args; args = []; opts = {}; }
  else if (typeof opts === 'function') { cb = opts; opts = {}; }
  const child = spawn(file, args || [], opts || {});
  let out = Buffer.alloc(0), err = Buffer.alloc(0);
  if (child.stdout) child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
  if (child.stderr) child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
  child.on('exit', (code) => {
    const enc = (opts && opts.encoding) || 'utf8';
    const so = enc === 'buffer' ? out : out.toString(enc);
    const se = enc === 'buffer' ? err : err.toString(enc);
    if (cb) cb(code === 0 ? null : Object.assign(new Error(`Command failed: ${file}`), { code }), so, se);
  });
  child.on('error', (e) => { if (cb) cb(e, '', ''); });
  return child;
}

function execFileSync(file, args, opts) {
  if (!Array.isArray(args)) { opts = args; args = []; }
  const r = spawnSync(file, args || [], opts || {});
  if (r.error) throw r.error;
  if (r.status !== 0) throw Object.assign(new Error(`Command failed: ${file}`), { status: r.status, stderr: r.stderr });
  return r.stdout;
}

// exec/execSync run a command string through the shell, mirroring node.
function exec(command, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return execFile('/bin/sh', ['-c', command], opts || {}, cb);
}
function execSync(command, opts) { return execFileSync('/bin/sh', ['-c', command], opts || {}); }

module.exports = { spawn, spawnSync, execFile, execFileSync, exec, execSync };

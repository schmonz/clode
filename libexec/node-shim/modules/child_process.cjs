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
const { Readable } = require('node:stream');
const { writeSyncFdBytes } = require('../internal/stdio-write.cjs');
const FSS = globalThis.__tjs_fs_sync;

// Opt-in spawn tracing (CLODE_SHIM_TRACE=1) — diagnostic for the -p wall-walk;
// silent unless enabled. Writes to stderr so it never pollutes the -p stdout.
const TRACE = !!(globalThis.process && globalThis.process.env && globalThis.process.env.CLODE_SHIM_TRACE);
function trace() { if (TRACE) { try { console.error('[cp]', ...arguments); } catch { /* best effort */ } } }

const CP_IS_WIN = (globalThis.process && process.platform === 'win32');

// Node's child_process OMITS an env key whose value is `undefined` entirely —
// it does NOT stringify it. Every other primitive IS stringified normally,
// including null ("null"), 0 ("0"), false ("false"), and '' (kept, empty
// string). Verified by direct differential against host node v26.3.0 (RECIPE
// G6): `cp.spawnSync(exe, [], {env:{...,X:undefined,...}})` shows X absent
// from the child's process.env entirely.
//
// Both spawn() and spawnSync() must filter BEFORE handing the env object to
// tjs: spawn() passes the object straight to tjs.spawn(), whose native env
// handling (mod_process.c) calls JS_ToCString on every property value with no
// undefined special-case — an unfiltered `undefined` becomes the *string*
// "undefined" there too. spawnSync() builds `KEY=VALUE` pairs via
// Object.entries().map(), which has the same blind-stringify problem. This
// was the RECIPE G6 root cause: the bundle spawns `git -C <repo> ...` with
// `GIT_DIR: undefined` meant to mean "unset"; the shim turned it into the
// literal string "undefined", and `GIT_DIR=undefined git worktree list
// --porcelain` fails with `fatal: not a git repository: 'undefined'` — a real
// divergence from naude, which never sees that key at all.
function filterUndefinedEnv(envObj) {
  const out = {};
  for (const k of Object.keys(envObj)) {
    const v = envObj[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Node's own PATH search for a bare command (libuv's; libexec/path-lookup.cjs states it and is the one copy), so the
// shim spawns what node would: the env HANDED to the spawn decides PATH (and an env with no PATH searches libuv's
// /usr/bin:/bin, as node does), an empty POSIX entry is the child's cwd, and a candidate counts only if the spawn could
// run it (a non-executable `git` early on PATH no longer wins and then fails EACCES; node walks past it). On win32 that
// is libuv's .com/.exe, not PATHEXT: node cannot spawn a .cmd/.bat without a shell either. A miss returns the name, so
// the spawn reports the ENOENT. path-lookup.cjs rides at the archive root beside node-shim/ (and at libexec/ in a
// checkout), required on first spawn.
let _lookPath = null;
function resolveExe(file, env, cwd) {
  if (!_lookPath) ({ lookPath: _lookPath } = require('../../path-lookup.cjs'));
  const platform = CP_IS_WIN ? 'win32' : process.platform;
  const fsm = {
    statSync: (p) => ({ isFile: () => FSS.stat(p).kind === 'file' }),
    accessSync: (p, m) => FSS.access(p, m),
    constants: { X_OK: 1 },
  };
  return _lookPath(file, { env: env || {}, platform, cwd, fs: fsm }) || file;
}

// Map one node stdio slot value to what tjs.spawn accepts. 'inherit'/'ignore'
// pass through; a NUMBER is a raw fd the child should inherit (tjs.spawn's
// numeric-fd -> UV_INHERIT_FD path, added in the mod_process.c patch) — the
// Bash tool uses this to redirect a child's stdout/stderr into a log-file fd it
// opened via fs.promises.open. A stream object or anything else falls back to a
// 'pipe' (the shim then wraps proc.stdX as a node stream). When a slot is a
// number/inherit/ignore, tjs.spawn creates no pipe, so proc.stdX is undefined
// and child.stdX becomes null — matching node, where a redirected/inherited fd
// yields no readable stream on the parent's ChildProcess.
function normSlot(v, def) {
  if (typeof v === 'number') return v;
  if (v === 'inherit') return 'inherit';
  if (v === 'ignore') return 'ignore';
  return def;
}
function normStdio(opts) {
  const s = opts.stdio;
  const one = (i, def) => Array.isArray(s) ? (s[i] ?? def) : (s ?? def);
  return {
    stdin: normSlot(one(0, 'pipe'), 'pipe'),
    stdout: normSlot(one(1, 'pipe'), 'pipe'),
    stderr: normSlot(one(2, 'pipe'), 'pipe'),
  };
}

// THE OPTIONS each entry point honours or refuses by name: libexec/node-shim/internal/options.cjs, held to node's own
// list by test/options-census.test.cjs. Refusals come first, before anything is spawned.
const { refuseOptions, optionError } = require('../internal/options.cjs');
const { engineFloorLog } = require('../internal/engine-floor-log.cjs');
// A stdio slot this engine can give the child: node's strings, a descriptor number, or nothing. 'ipc' (no channel)
// and a stream object (node passes its descriptor; this engine has none to pass) are refused by name, not piped.
function refuseStdio(entry, opts) {
  const s = opts.stdio;
  if (s === undefined || s === null || s === 'pipe' || s === 'overlapped' || s === 'inherit' || s === 'ignore') return;
  if (!Array.isArray(s)) throw optionError(entry, 'stdio', `the value ${JSON.stringify(s)} is not one this engine can give a child`);
  s.forEach((v, i) => {
    if (v === undefined || v === null || v === 'pipe' || v === 'overlapped' || v === 'inherit' || v === 'ignore') return;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return;
    if (i > 2) throw optionError(entry, 'stdio', `slot ${i}: the engine gives a child descriptors 0-2 only`);
    throw optionError(entry, 'stdio', v === 'ipc' ? 'there is no IPC channel' : `slot ${i}: a ${typeof v} is not a slot this engine can give a child (only 'pipe', 'inherit', 'ignore' or a descriptor number)`);
  });
}
// The options only an engine with txiki-spawn-options.patch applies: each is refused by name on an older engine (and
// logged for CLODE_ENGINE_FLOOR_LOG) when the caller asks for something, and handed to the engine otherwise.
const WIN_ONLY = new Set(['windowsHide', 'windowsVerbatimArguments']);
const ENGINE_ASYNC = ['detached', 'windowsHide', 'windowsVerbatimArguments', 'argv0'];
const ENGINE_SYNC = ['windowsHide', 'windowsVerbatimArguments', 'argv0', 'killSignal'];
function engineSpawnOptions(entry, opts, supported, keys) {
  const out = {};
  for (const k of keys) {
    const v = opts[k];
    if (v === undefined || v === null || v === false) continue;
    if (WIN_ONLY.has(k) && !CP_IS_WIN) continue;            // node applies these on Windows only
    if (!supported.includes(k)) {
      engineFloorLog(`${entry} option '${k}': this engine predates txiki-spawn-options.patch`);
      throw optionError(entry, k, `${ENGINE_SPAWN_WHY} (txiki-spawn-options.patch)`);
    }
    out[k] = v;
  }
  return out;
}
const ENGINE_SPAWN_WHY = 'this engine\'s spawner does not apply it';
// node's killSignal: a name or a number, validated as node does (ERR_UNKNOWN_SIGNAL); answered as a NAME.
function killSignalName(v) {
  if (v === undefined || v === null) return 'SIGTERM';
  if (typeof v === 'number') { const n = signalName(v); if (n) return n; }
  else if (typeof v === 'string') { const sig = (require('node:os').constants || {}).signals || {}; if (sig[v] !== undefined) return v; }
  throw Object.assign(new TypeError(`Unknown signal: ${v}`), { code: 'ERR_UNKNOWN_SIGNAL' });
}
function abortError(signal) {
  const e = new Error('The operation was aborted', signal && signal.reason !== undefined ? { cause: signal.reason } : undefined);
  e.name = 'AbortError'; e.code = 'ABORT_ERR';
  return e;
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
  const command = (args && args.length) ? [file, ...args].join(' ') : String(file);
  if (CP_IS_WIN) {
    // Node's exact Windows convention: cmd.exe /d /s /c "<command>", with the
    // /c payload passed VERBATIM (windowsVerbatimArguments) — NOT argv-quoted.
    // The spawn primitive must not re-quote these args; see __winVerbatim below.
    const comspec = (globalThis.process && process.env.ComSpec) || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', command], __winVerbatim: true };
  }
  const shellExe = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
  return { file: shellExe, args: ['-c', command] };
}

function spawn(file, args = [], opts = {}) {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  opts = opts || {};
  refuseOptions('child_process.spawn', opts);
  refuseStdio('child_process.spawn', opts);
  const killSignal = killSignalName(opts.killSignal);
  const engineOpts = engineSpawnOptions('child_process.spawn', opts, globalThis.__tjs_spawn_options || [], ENGINE_ASYNC);
  const abortSignal = opts.signal;
  if (abortSignal !== undefined && abortSignal !== null
      && (typeof abortSignal !== 'object' || typeof abortSignal.aborted !== 'boolean')) {
    throw Object.assign(new TypeError('The "options.signal" property must be an instance of AbortSignal'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  // Default the child's environment to the CURRENT env (tjs.env), not undefined.
  // Node inherits the live process.env — including mutations — when `env` is
  // omitted; tjs.env is the object process.env's set/deleteProperty traps write
  // through (process.cjs), so it carries those mutations. Passing undefined here
  // let tjs snapshot the original C environ instead, so `process.env.X = v`
  // followed by a default-env spawn dropped X in the child (a silent divergence
  // from node; the runtime does NOT mirror tjs.env back into the real environ on
  // this engine, contrary to the old assumption).
  const env = filterUndefinedEnv(opts.env || tjs.env);
  const stdio = normStdio(opts);
  const shelled = applyShell(file, args, opts);
  file = shelled.file; args = shelled.args;
  const winVerbatim = !!shelled.__winVerbatim;
  trace('spawn', file, JSON.stringify(args), 'stdio=', JSON.stringify(stdio));
  const child = new EventEmitter();
  let proc;
  try {
    proc = tjs.spawn([resolveExe(file, env, opts.cwd), ...args], {
      cwd: opts.cwd, env, stdin: stdio.stdin, stdout: stdio.stdout, stderr: stdio.stderr,
      uid: opts.uid, gid: opts.gid,
      detached: !!engineOpts.detached, windowsHide: !!engineOpts.windowsHide,
      windowsVerbatimArguments: winVerbatim || !!engineOpts.windowsVerbatimArguments,
      ...(typeof engineOpts.argv0 === 'string' ? { argv0: engineOpts.argv0 } : {}),
    });
  } catch (err) {
    // DIVERGENCE A: tjs.spawn throws sync on ENOENT; node emits the failure
    // asynchronously instead. On a launch failure host node (v24.18.0,
    // verified) fires BOTH 'error' THEN 'close' — and does NOT fire 'exit'.
    // The 'close' args are (code, signal) = (-2, null): code -2 is -errno for
    // ENOENT (node's own value), signal null. We MUST emit 'close' too, else a
    // caller using the (more common) 'close'-listener lifecycle idiom after a
    // failed spawn waits forever — a silent hang the fail-loud standard forbids.
    //
    // RECIPE G6 root cause: a stdio slot requesting 'pipe' still gets a REAL
    // (if immediately-ended) stream on host node — c.stdout/stderr/stdin are
    // never null when 'pipe' was requested, even on launch failure (verified,
    // host node v24.18.1): stdout/stderr fire 'end' then 'close'
    // (readable=false, destroyed=true), stdin fires 'close' (writable=false,
    // destroyed=true, a post-failure write() is a silent false no-op — no
    // throw, no 'error'), and exitCode/signalCode are set to the same
    // (-2, null) the 'close' event carries — never left at their null
    // defaults. This shim used to hard-null every stdio slot on a failed
    // spawn regardless of what was requested: any caller that unconditionally
    // does `child.stdout.on('end', …)` (execa's stream collectors do exactly
    // this) got nothing back and its wait/exit promise never settled —
    // dangling handles that kept the tjs event loop alive forever after a
    // bare, unresolvable command name (e.g. `rg` with no absolute path)
    // failed to spawn. Build real, already-ended node-shim streams for every
    // 'pipe' slot so those listeners fire and settle, exactly as node does;
    // leave non-'pipe' slots null, matching node's 'ignore'/'inherit' shape.
    const mkEndedReadable = () => {
      const r = new Readable({ read() {} });
      r.push(null);   // schedules 'end'
      r.destroy();    // schedules 'close' (queued after 'end', FIFO)
      return r;
    };
    const mkEndedWritable = () => {
      const w = new EventEmitter();
      w.writable = false;
      w.writableEnded = true;
      w.destroyed = true;
      w.write = () => false; // matches node: silent false no-op, no throw/error
      w.end = (chunk, encOrCb, cb) => {
        if (typeof chunk === 'function') cb = chunk;
        else if (typeof encOrCb === 'function') cb = encOrCb;
        if (typeof cb === 'function') queueMicrotask(cb);
        return w;
      };
      w.destroy = () => w;
      w.cork = () => {}; w.uncork = () => {}; w.setDefaultEncoding = () => w;
      queueMicrotask(() => w.emit('close'));
      return w;
    };
    child.pid = undefined;
    child.stdout = stdio.stdout === 'pipe' ? mkEndedReadable() : null;
    child.stderr = stdio.stderr === 'pipe' ? mkEndedReadable() : null;
    child.stdin = stdio.stdin === 'pipe' ? mkEndedWritable() : null;
    child.kill = () => false;
    child.ref = () => {}; child.unref = () => {};
    const closeCode = typeof err.errno === 'number' ? err.errno : -2; // -errno (ENOENT -> -2)
    child.exitCode = closeCode;
    child.signalCode = null;
    queueMicrotask(() => {
      child.emit('error', launchError(err, 'spawn', file, args));
      child.emit('close', closeCode, null);
    });
    return child;
  }
  child.pid = proc.pid;
  // node emits 'spawn' once the child has been successfully spawned, BEFORE any
  // stdout/stderr data and before 'exit'; on a launch failure it emits 'error'
  // instead and never 'spawn' (see the failure path above, which correctly does
  // not emit it). This shim never emitted it at all.
  //
  // That broke MCP over stdio COMPLETELY. The MCP SDK's StdioClientTransport
  // .start() resolves its connect promise on exactly this event, so under quaude
  // the transport never finished connecting: it wrote no bytes, the server sat
  // on an empty stdin and exited at EOF, and the client reported the server as
  // "still connecting" forever and then hung. Every stdio MCP server was
  // unusable, with no error anywhere — the reference completed the same
  // handshake and returned its tool result.
  //
  // Deferred to a macrotask, not queueMicrotask: node's 'spawn' lands on a
  // later turn than the synchronous spawn() return, so a caller that attaches
  // .on('spawn') right after spawn() returns still receives it.
  setTimeout(() => { try { child.emit('spawn'); } catch { /* listener threw */ } }, 0);
  // Wrap tjs WHATWG streams as a REAL node-shim stream.Readable (Task 4b fix),
  // not a bare EventEmitter. The bundle's credential read goes through execa,
  // and execa/get-stream's collector (`aLt` in the staged cli.cjs) gates on
  // `typeof stream[Symbol.asyncIterator] === 'function'` (its `CYu` check)
  // before it will even start consuming — a bare EventEmitter has no such
  // method, so execa silently collected NOTHING from a spawned `security`
  // read, `xbs()` returned null, and the bundle fell back to "Not logged in"
  // even though the subscription credential was right there in the Keychain.
  // Confirmed by diffing this same staged bundle's `-p` boot under host node
  // (prints PONG) vs tjs (printed "Not logged in") — host node's real
  // ChildProcess.stdout has .pipe()/[Symbol.asyncIterator]()/paused-mode
  // buffering; the shim's old wrapReadable had none of the three. Reusing
  // stream.cjs's Readable gives ALL of them (pipe, asyncIterator, on('data'))
  // for free instead of forking a second stream implementation.
  const wrapReadable = (s, which) => {
    if (!s) return null;
    const r = new Readable({ read() {} });
    // .destroy() must ALSO cancel the underlying WHATWG reader (stopping the
    // drain loop below), on top of Readable's own destroyed/'close' contract
    // — the execa-style cleanup (get-stream's `Q2n`) calls stdout.destroy()
    // on the error/cleanup path.
    const baseDestroy = r.destroy.bind(r);
    r.destroy = (err) => {
      if (r.destroyed) return r;
      try { r._reader && r._reader.cancel(); } catch { /* already closed */ }
      return baseDestroy(err);
    };
    (async () => {
      try {
        // Assigned synchronously (before the first await, since an async
        // function body runs sync up to its first await) so a destroy() call
        // made right after wrapReadable() returns can still find and cancel it.
        const reader = s.getReader();
        r._reader = reader;
        for (;;) {
          if (r.destroyed) break;
          const { value, done } = await reader.read();
          if (done) break;
          if (value) r.push(Buffer.from(value));
        }
        trace('stream end', file, which);
        r.push(null);
      } catch (e) { trace('stream error', file, which, String(e)); r.emit('error', e); }
    })();
    return r;
  };
  child.stdout = wrapReadable(proc.stdout, 'stdout');
  child.stderr = wrapReadable(proc.stderr, 'stderr');
  // child.stdin: wrap the tjs WHATWG WritableStream as a REAL node Writable
  // (EventEmitter with write/end/on/once/destroy). The bundle's hook runner
  // writes the hook-input JSON to the child's stdin (`stdin.on('error',…);
  // stdin.write(…); stdin.end()`) — a raw passthrough has none of those methods,
  // so `stdin.write` was undefined → "not a function" (the interactive
  // SessionStart:startup hook failure, after the setEncoding one). Writes are
  // best-effort fire-and-forget over getWriter(): the bundle resolves its own
  // write-promise synchronously without awaiting delivery, and raw tjs
  // child-stdin writes don't reliably resolve (DIVERGENCE C) — so we must never
  // block on them. Characterized in test/node-shim-child-process.test.cjs.
  const wrapWritable = (ws) => {
    if (!ws) return null;
    const w = new EventEmitter();
    let writer = null;
    // Tracks whether the underlying WHATWG WritableStream (and therefore its
    // native pipe handle) has already been ended/aborted — by an explicit
    // caller end()/destroy(), OR by the child-exit cleanup below (RECIPE G6:
    // see the wait().then handler's endWriter). Guards against a redundant
    // close()/abort() call racing the explicit one, and lets that cleanup
    // skip a stdin the caller already properly ended.
    w.destroyed = false;
    const enc = new TextEncoder();
    const getW = () => { if (!writer) { try { writer = ws.getWriter(); } catch { /* locked/closed */ } } return writer; };
    w.writable = true;
    w.write = (chunk, encOrCb, cb) => {
      if (typeof encOrCb === 'function') cb = encOrCb;
      try {
        const bytes = Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : enc.encode(String(chunk));
        const wr = getW();
        if (wr) wr.write(bytes).catch((e) => w.emit('error', e)); // fire-and-forget
      } catch (e) { queueMicrotask(() => w.emit('error', e)); }
      if (typeof cb === 'function') queueMicrotask(cb);
      return true;
    };
    w.end = (chunk, encOrCb, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      else if (typeof encOrCb === 'function') cb = encOrCb;
      if (chunk != null) w.write(chunk);
      if (!w.destroyed) {
        w.destroyed = true;
        try { const wr = getW(); if (wr) wr.close().catch(() => {}); } catch { /* ignore */ }
      }
      if (typeof cb === 'function') queueMicrotask(cb);
      queueMicrotask(() => { w.emit('finish'); w.emit('close'); });
      return w;
    };
    w.destroy = () => {
      if (w.destroyed) return w;
      w.destroyed = true;
      try { const wr = getW(); if (wr) (wr.abort ? wr.abort() : wr.close()).catch(() => {}); } catch { /* ignore */ }
      queueMicrotask(() => w.emit('close'));
      return w;
    };
    w.cork = () => {}; w.uncork = () => {}; w.setDefaultEncoding = () => w;
    return w;
  };
  child.stdin = wrapWritable(proc.stdin);
  child.killed = false;
  child.kill = (sig) => {
    try { proc.kill(sig === undefined ? undefined : killSignalName(sig)); child.killed = true; return true; } catch { return false; }
  };
  child.ref = () => {}; child.unref = () => {};
  // node's timeout and signal: kill with killSignal; an abort also emits node's AbortError
  let timeoutTimer = null;
  if (typeof opts.timeout === 'number' && opts.timeout > 0) {
    timeoutTimer = setTimeout(() => { timeoutTimer = null; child.kill(killSignal); }, opts.timeout);
  }
  let onAbort = null;
  if (abortSignal) {
    onAbort = () => { child.kill(killSignal); child.emit('error', abortError(abortSignal)); };
    if (abortSignal.aborted) queueMicrotask(onAbort);
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const settleWatchers = () => {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (onAbort && abortSignal && !abortSignal.aborted) abortSignal.removeEventListener('abort', onAbort);
  };
  proc.wait().then(
    // A KILLED child is not a SUCCESSFUL child. tjs's wait() reports
    // {exit_status, term_signal} and sets exit_status=0 for a signal kill
    // (verified: SIGKILL -> {"exit_status":0,"term_signal":"SIGKILL"}; `exit 3` ->
    // {"exit_status":3,"term_signal":null}). Node's contract is different and is
    // what every caller codes against: a signal-terminated child reports code=null
    // + signal=<name>, and exitCode=null/signalCode=<name>. Passing exit_status
    // through made a killed child indistinguishable from a clean exit 0 — so the
    // one question everyone asks (`code === 0`?) answered "it worked" about a
    // process we had just killed. That is how "ATTEST FAILED (exit 0)" happened on
    // haiku-x64 (a 20-minute timeout SIGKILL reported as success, 2026-07-17), and
    // Claude Code's Bash tool kills timed-out commands through this same path.
    // signalCode must be set even when null: node always exposes it, and a missing
    // key is its own divergence. Oracle: test/node-shim-child-process.test.cjs.
    (st) => {
      const signal = st.term_signal || null;
      const code = signal ? null : st.exit_status;
      trace('wait resolved', file, 'exit=', st.exit_status, 'signal=', signal);
      child.exitCode = code;
      child.signalCode = signal;
      settleWatchers();
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
      // The child is gone, but a FORKED grandchild can inherit and hold the stdio
      // pipes open: dash (musl/alpine's /bin/sh) runs `sh -c 'sleep 30'` as a
      // CHILD rather than exec-replacing, so SIGKILLing the sh leaves an orphaned
      // sleep (reparented to init) still holding the pipe. tjs's eager drain loop
      // then stays blocked on reader.read() with no EOF, keeping the event loop
      // alive so the process never exits — the node-shim-oracle SIGKILL hang (musl
      // only; NetBSD sh exec-replaces, so no orphan and no hang). Node doesn't keep
      // the loop alive for an unconsumed child stream once the child has exited.
      // Cancel the SOURCE readers so each drain loop ends with EOF; data already
      // pushed into the node Readable still flushes to a late consumer.
      const endReader = (rd) => { try { if (rd && rd._reader) rd._reader.cancel(); } catch { /* already closed */ } };
      endReader(child.stdout);
      endReader(child.stderr);
      // RECIPE G6: a 'pipe' stdin the caller never wrote to and never
      // end()/destroy()ed (the common case — most bundle spawns of git/sh
      // etc. request stdin:'pipe' but have nothing to send) left the
      // PARENT's end of that pipe's native handle open forever: nothing in
      // this file ever called the underlying WritableStream's close()/
      // abort() algorithm (mod .../process.js's ProcessWritableStream,
      // which is what actually calls the tjs Pipe handle's .close()) unless
      // the CALLER did. Host node destroys a child's stdio streams once the
      // child exits regardless of whether the caller ever touched them —
      // mirror that here now that the child is confirmed gone (wait()
      // resolved): any further write would be pointless anyway. Traced
      // live: 14-16 such unclosed stdin pipe handles (one per 'pipe'-stdin
      // spawn whose stdin the bundle never used) accumulate over the course
      // of a single `-p` boot. destroy() is idempotent (guarded by
      // w.destroyed above) so this is a no-op for a stdin the caller
      // already ended.
      if (child.stdin && typeof child.stdin.destroy === 'function') child.stdin.destroy();
    },
    (e) => { trace('wait rejected', file, String(e)); child.emit('error', e); },
  );
  return child;
}

// spawnSync: real synchronous spawn over the C primitive __tjs_spawn_sync
// (posix_spawn + poll drain; DIVERGENCE B resolved on darwin — see header).
// Node result shape; encoding/toString + PATH resolution + shell done here.
function spawnSync(file, args = [], opts = {}, entry = 'child_process.spawnSync') {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  opts = opts || {};
  refuseOptions(entry, opts);
  refuseStdio(entry, opts);
  const killSignal = killSignalName(opts.killSignal);
  const syncSupported = (globalThis.__tjs_spawn_sync && globalThis.__tjs_spawn_sync.options) || [];
  const engineOpts = engineSpawnOptions(entry, opts, syncSupported, ENGINE_SYNC);
  const shelled = applyShell(file, args, opts);
  file = shelled.file; args = shelled.args;
  const winVerbatim = !!shelled.__winVerbatim;
  // KNOWN LIMITATION (Phase 2, JS-only scope): __tjs_spawn_sync's C primitive
  // builds one command line via MS-argv quoting and has no verbatim mode, so
  // the win shell-mode /c payload above is re-quoted by the C side rather than
  // passed through raw. cmd.exe tolerates the argv-quoted /c argument for the
  // common command shapes the bundle uses (no embedded quotes). If Task 5's
  // Windows oracle hits a real cmd-quoting wall, escalate to a C
  // windowsVerbatimArguments flag on __tjs_spawn_sync (a wall-walk item) —
  // NOT a Phase-2 JS change.
  trace('spawnSync', file, JSON.stringify(args));
  if (typeof globalThis.__tjs_spawn_sync !== 'function') {
    throw new Error('node-shim: child_process.spawnSync needs __tjs_spawn_sync (rebuild tjs with txiki-sync-spawn.patch — see child_process.cjs header)');
  }
  // Default to the CURRENT env (tjs.env), not undefined — see spawn() above:
  // a default-env child must inherit process.env mutations, and this engine
  // does not mirror tjs.env into the real environ, so it must be passed.
  const env = Object.entries(filterUndefinedEnv(opts.env || tjs.env)).map(([k, v]) => `${k}=${v}`);
  let input;
  if (opts.input != null) {
    const b = Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(String(opts.input));
    // pass a real ArrayBuffer slice (the C side reads an ArrayBuffer)
    input = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const exe = resolveExe(file, filterUndefinedEnv(opts.env || tjs.env), opts.cwd);
  const slots = normStdio(opts);
  // The engine's spawner takes the slots (txiki-sync-spawn.patch: `__tjs_spawn_sync.stdio`): an inherited slot is
  // the parent's own fd in the child, an ignored one /dev/null (NUL), and only a 'pipe' is captured. An engine that
  // predates that (the build host's last-release engine) pipes every slot, and the bytes are replayed below.
  const engineStdio = globalThis.__tjs_spawn_sync.stdio === true;
  const cSlot = (v, i) => (v === 'inherit' ? i : v);
  let r;
  try {
    r = globalThis.__tjs_spawn_sync(exe, args, {
      cwd: opts.cwd, env, input,
      stdio: engineStdio ? [cSlot(slots.stdin, 0), cSlot(slots.stdout, 1), cSlot(slots.stderr, 2)] : undefined,
      timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : 0,
      // Match node's real spawnSync default (1 MiB) exactly — no divergence.
      maxBuffer: typeof opts.maxBuffer === 'number' ? opts.maxBuffer : (1024 * 1024),
      // node's default killSignal is SIGTERM; an engine without the option kills with SIGKILL (as it always did)
      ...(syncSupported.includes('killSignal') ? { killSignal: require('node:os').constants.signals[killSignal] } : {}),
      ...(typeof engineOpts.argv0 === 'string' ? { argv0: engineOpts.argv0 } : {}),
      ...(engineOpts.windowsHide ? { windowsHide: true } : {}),
      ...((winVerbatim || engineOpts.windowsVerbatimArguments) ? { windowsVerbatimArguments: true } : {}),
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
  // STDIO WAS IGNORED HERE UNTIL 2026-09-20, and a cross leg died of it in silence: `tjs-slow / leg
  // (netbsd-mips64eb)` (CI run 35530707866) printed nothing for a minute and then a bare stack trace, because
  // scripts/build-tjs.cjs runs every child as `execFileSync(cmd, args, { stdio: 'inherit' })` under tjs and this
  // function never looked at opts.stdio: every child's output was captured into a Buffer and dropped.
  //
  // The engine now INHERITS (txiki-sync-spawn.patch, 2026-11-22): the child writes to the caller's own fd while it
  // runs, with no pipe, no maxBuffer and nothing to replay, as under node; and a relaunched TUI gets the terminal
  // it takes over (2.1.330's Windows relaunch is exactly `spawnSync(cmd, args, {stdio:'inherit'})`; on POSIX the
  // same fallback ran whenever process.execve was missing, and rendered into a pipe nobody read).
  //
  // REPLAY remains only for an engine that predates that, which pipes every slot: the captured bytes are written
  // to the parent's own fd after the child exits. Same bytes, not live, and a child writing more than maxBuffer to
  // an "inherited" slot is killed there. scripts/engine-api-floor.cjs says why the build host may still be such an
  // engine; nothing shipped is (`__tjs_spawn_sync.stdio` is on the runtime floor).
  //
  // The RETURN shape matches node either way: a slot that was not a pipe reads back null.
  const replay = (slot, fd, buf) => {
    if (slot === 'pipe') return conv(buf);
    if (!engineStdio && slot === 'inherit' && buf && buf.byteLength) {
      try { writeSyncFdBytes(fd, new Uint8Array(buf)); } catch { /* a closed fd is not this call's failure */ }
    }
    return null;
  };
  const out = replay(slots.stdout, 1, r.stdout);
  const err = replay(slots.stderr, 2, r.stderr);
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

// node's execFile: the spawn options it passes on (cwd, env, uid, gid, shell, signal, windows*), plus its own
// timeout/killSignal (the child is killed and the error says so) and maxBuffer (1 MiB by default: past it the child
// is killed and the error is ERR_CHILD_PROCESS_STDIO_MAXBUFFER), and encoding.
function execFile(file, args, opts, cb) {
  if (typeof args === 'function') { cb = args; args = []; opts = {}; }
  else if (typeof opts === 'function') { cb = opts; opts = {}; }
  else if (args && !Array.isArray(args) && typeof args === 'object') { cb = opts; opts = args; args = []; }
  opts = opts || {};
  const entry = opts.__shimEntry || 'child_process.execFile';
  refuseOptions(entry, opts);
  const killSignal = killSignalName(opts.killSignal);
  const maxBuffer = typeof opts.maxBuffer === 'number' ? opts.maxBuffer : 1024 * 1024;
  const spawnOpts = { cwd: opts.cwd, env: opts.env, uid: opts.uid, gid: opts.gid, shell: opts.shell, signal: opts.signal,
    windowsHide: opts.windowsHide, windowsVerbatimArguments: opts.windowsVerbatimArguments, killSignal };
  const child = spawn(file, args || [], spawnOpts);
  let out = Buffer.alloc(0), err = Buffer.alloc(0);
  let timedOut = false, overflow = null, done = false;
  let timer = null;
  if (typeof opts.timeout === 'number' && opts.timeout > 0) {
    timer = setTimeout(() => { timer = null; timedOut = true; child.kill(killSignal); }, opts.timeout);
  }
  const take = (which) => (d) => {
    if (which === 'stdout') out = Buffer.concat([out, d]); else err = Buffer.concat([err, d]);
    if (!overflow && Number.isFinite(maxBuffer) && (which === 'stdout' ? out : err).length > maxBuffer) {
      overflow = which;
      if (which === 'stdout') out = out.subarray(0, maxBuffer); else err = err.subarray(0, maxBuffer);
      child.kill(killSignal);
    }
  };
  if (child.stdout) child.stdout.on('data', take('stdout'));
  if (child.stderr) child.stderr.on('data', take('stderr'));
  const enc = opts.encoding || 'utf8';
  const text = (b) => (enc === 'buffer' ? b : b.toString(enc));
  const cmd = [file, ...(args || [])].join(' ');
  const finish = (e) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (cb) cb(e, text(out), text(err)); };
  child.on('close', (code, signal) => {
    if (overflow) {
      finish(Object.assign(new RangeError(`${overflow} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd }));
      return;
    }
    if (code === 0 && signal === null) { finish(null); return; }
    const e = new Error(`Command failed: ${cmd}\n${text(err)}`);
    e.code = code; e.killed = child.killed || timedOut; e.signal = signal; e.cmd = cmd;
    finish(e);
  });
  child.on('error', (e) => finish(e));
  return child;
}

// node's execFileSync, both halves of its stderr contract (lib/child_process.js):
//   1. stdio UNSPECIFIED -> the child's captured stderr is written to the parent's
//      stderr, failing or not (`inheritStderr = !options.stdio`);
//   2. a nonzero exit throws `Command failed: <file> <args...>` + "\n" + the stderr,
//      carrying status/signal/output/pid/stdout/stderr.
// The shim did neither until 2026-11-19: CI run 44460009323's dragonflybsd leg died on
// build-tjs's runOut('cmake', ['--version']) with a bare `Command failed: cmake`, while
// the line that said WHY (`Shared object "libcrypto.so.17" not found`) was captured into
// a Buffer and dropped — on every leg that runs the build under tjs.
function execFileSync(file, args, opts, entry = 'child_process.execFileSync') {
  if (!Array.isArray(args)) { opts = args; args = []; }
  args = args || []; opts = opts || {};
  const r = spawnSync(file, args, opts, entry);
  // Exactly node's call: `if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr)`.
  if (!opts.stdio && r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw Object.assign(r.error, r);
  if (r.status !== 0) {
    let msg = `Command failed: ${[opts.argv0 || file, ...args].join(' ')}`;
    if (r.stderr != null && r.stderr.length) msg += `\n${r.stderr.toString()}`;
    throw Object.assign(new Error(msg), r);
  }
  return r.stdout;
}

// exec/execSync run a command string through the shell, mirroring node
// (cmd.exe on Windows via applyShell, /bin/sh on POSIX). Delegate {shell:true}
// through so applyShell runs ONCE inside spawn/spawnSync — pre-resolving here
// and re-entering spawn drops the win __winVerbatim flag (cmd /c must stay
// verbatim; a double applyShell re-quotes it).
// exec/execSync run the command through a shell: the caller's `shell` (a path) when it names one, else node's default
function exec(command, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  return execFile(command, [], { ...opts, shell: typeof opts.shell === 'string' ? opts.shell : true, __shimEntry: 'child_process.exec' }, cb);
}
function execSync(command, opts) {
  opts = opts || {};
  return execFileSync(command, [], { ...opts, shell: typeof opts.shell === 'string' ? opts.shell : true }, 'child_process.execSync');
}

module.exports = { spawn, spawnSync, execFile, execFileSync, exec, execSync };

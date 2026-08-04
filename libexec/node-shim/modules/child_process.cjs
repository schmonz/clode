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

function resolveExe(file, env) {
  // Node resolves a bare command via PATH for spawn; a path with a separator is
  // used as-is. On Windows the separator is \ or / or a drive letter, PATH is
  // ;-delimited, and a bare name without an extension is probed against PATHEXT
  // (.COM;.EXE;.BAT;.CMD;...) — this is how the bundle's Bash tool finds bash.exe.
  if (file.includes('/') || (CP_IS_WIN && (file.includes('\\') || /^[a-zA-Z]:/.test(file)))) return file;
  const delim = CP_IS_WIN ? ';' : ':';
  const exts = CP_IS_WIN
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const alreadyHasExt = CP_IS_WIN && /\.[^.\\/]+$/.test(file);
  for (const dir of String((env && env.PATH) || process.env.PATH || '').split(delim)) {
    if (!dir) continue;
    for (const ext of (alreadyHasExt ? [''] : exts)) {
      const p = path.join(dir, file + ext);
      try { if (FSS.stat(p).kind === 'file') return p; } catch { /* keep looking */ }
    }
  }
  return file; // let spawn surface the ENOENT
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

// ---- quaude enhancement (NOT upstream fidelity): headless-macOS keychain ----
// Upstream Claude Code assumes every macOS has a GUI login session and stores
// credentials in the login Keychain via `security`. On a HEADLESS macOS box
// (over SSH, no window session — e.g. a Mac mini or a vintage machine driven
// remotely) the login Keychain is unavailable and upstream dead-ends: it prints
// "Run `security unlock-keychain`" and never persists the token, so every launch
// demands /login again. That is a deliberate upstream assumption, not a bug we
// can fix upstream-faithfully — so this is an intentional DIVERGENCE for the
// mission of running on whatever computer: when the real Keychain is usable
// (Tahoe, a headful Mac) we pass every `security` call through untouched (full
// fidelity); when it is NOT usable, we back the credential `security` ops with a
// file so the token persists. Detection is a real round-trip probe (write+read+
// delete a throwaway item with CC's exact flags) — robust against both a locked/
// absent session AND an ancient `security` CLI that lacks -U/-w/-X (Tiger's 2005
// build rejects them). Scoped to exactly the credential subcommands; everything
// else is untouched. Store: ~/.claude/.keychain-emulation.json (quaude-private).
// _kcMode: undefined=unprobed | 'passthrough' (modern keychain, CC untouched) |
// 'translate' (old keychain reachable, adapt flags to real keychain) | 'emulate'
// (no keychain — headless/locked — back with a file). Probed once, lazily.
// _kcCaps holds the detected per-flag capabilities of the local `security`.
let _kcMode, _kcCaps;
function _kcFilePath() {
  const home = (tjs.env && (tjs.env.HOME || tjs.env.USERPROFILE)) || '';
  return path.join(home, '.claude', '.keychain-emulation.json');
}
function _kcLoad() {
  try {
    const fd = FSS.open(_kcFilePath(), 'r');
    try {
      const ab = FSS.read(fd, 1 << 20, 0);
      const txt = new TextDecoder().decode(new Uint8Array(ab));
      return txt ? JSON.parse(txt) : {};
    } finally { FSS.close(fd); }
  } catch { return {}; }
}
function _kcSave(db) {
  const p = _kcFilePath(), tmp = p + '.tmp';
  const bytes = new TextEncoder().encode(JSON.stringify(db)).buffer;
  const fd = FSS.open(tmp, 'w');
  try { FSS.write(fd, bytes, -1); } finally { FSS.close(fd); }
  FSS.rename(tmp, p);
}
// The Linux fallback: the ONE keychain entry Claude Code uses for credentials
// (service ends in `-credentials`; its keychain "password" is byte-for-byte the
// `{claudeAiOauth:{…}}` JSON that CC's non-darwin file store keeps in
// ~/.claude/.credentials.json). In `emulate` mode we back THAT entry with the
// upstream .credentials.json — NOT the quaude-private .keychain-emulation.json —
// so creds are shared/portable across platforms (a login here shows up on Linux,
// and creds dropped in by any Claude Code work here). Non-credential entries
// stay in the emulation file.
function _isCredsSvc(svc) { return typeof svc === 'string' && /-credentials$/.test(svc); }
function _credFilePath() {
  const home = (tjs.env && (tjs.env.HOME || tjs.env.USERPROFILE)) || '';
  return path.join(home, '.claude', '.credentials.json');
}
function _credRead() {
  try {
    const fd = FSS.open(_credFilePath(), 'r');
    try {
      const ab = FSS.read(fd, 1 << 20, 0);
      return new TextDecoder().decode(new Uint8Array(ab));
    } finally { FSS.close(fd); }
  } catch { return null; }
}
function _credWrite(txt) {
  const p = _credFilePath(), tmp = p + '.tmp';
  const bytes = new TextEncoder().encode(txt).buffer;
  const fd = FSS.open(tmp, 'w');
  try { FSS.write(fd, bytes, -1); } finally { FSS.close(fd); }
  FSS.rename(tmp, p);
}
function _credDelete() { try { FSS.unlink(_credFilePath()); } catch { /* absent: fine */ } }
function _kcSplitArgs(s) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { q = null; } else cur += c; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === ' ' || c === '\t') { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}
function _kcSecurityArgs(file, args, opts) {
  if (path.basename(String(file || '')) === 'security' && Array.isArray(args) && args.length) return args;
  // exec/execSync pass the whole command STRING as `file` with opts.shell set
  if (opts && opts.shell && typeof file === 'string') {
    const m = /^\s*(?:\S*\/)?security\s+(.+)$/.exec(file);
    if (m) return _kcSplitArgs(m[1]);
  }
  return null;
}
function _kcHandleFile(args) { // 'emulate' backend: no reachable keychain -> file store
  const sub = args[0];
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  // report the keychain "available" (CC's J4i keys on exit 36) so CC takes the
  // keychain path — which we then back with the file.
  if (sub === 'show-keychain-info') return { stdout: '', code: 36 };
  const acct = val('-a'), svc = val('-s');
  const creds = _isCredsSvc(svc); // the CC credentials entry -> the shared .credentials.json store
  if (sub === 'find-generic-password') {
    if (creds) {
      const txt = _credRead();
      if (txt == null || txt.trim() === '') return { stdout: '', code: 44 };
      return { stdout: txt.trim() + '\n', code: 0 }; // the {claudeAiOauth:…} JSON; CC .trim()s + parses
    }
    const db = _kcLoad();
    const has = db[svc] && Object.prototype.hasOwnProperty.call(db[svc], acct);
    if (!has) return { stdout: '', code: 44 }; // errSecItemNotFound (CC treats 0/44/36 as "no item")
    return { stdout: db[svc][acct] + '\n', code: 0 }; // -w prints the password; CC .trim()s it
  }
  if (sub === 'add-generic-password') {
    const hex = val('-X');
    const pw = hex != null ? Buffer.from(hex, 'hex').toString('utf8') : (val('-w') || val('-p') || '');
    if (creds) { _credWrite(pw); return { stdout: '', code: 0 }; } // persist the token to .credentials.json
    const db = _kcLoad(); (db[svc] = db[svc] || {})[acct] = pw; _kcSave(db);
    return { stdout: '', code: 0 };
  }
  if (sub === 'delete-generic-password') {
    if (creds) { _credDelete(); return { stdout: '', code: 0 }; }
    const db = _kcLoad(); if (db[svc]) { delete db[svc][acct]; _kcSave(db); }
    return { stdout: '', code: 0 };
  }
  return null; // any other security subcommand: don't emulate — pass through
}
function _kcRealSec(sargs) { // run REAL `security` synchronously (bypass this intercept)
  return spawnSync('security', sargs, { __kcBypass: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, encoding: 'utf8' });
}
// Old `security find-generic-password -g` prints the secret to STDERR, either
// `password: "..."` (printable, C-escaped) or `password: 0x<hex>` (binary).
function _kcParseG(text) {
  let m = /password:\s*0x([0-9a-fA-F]+)/.exec(text || '');
  if (m) { try { return Buffer.from(m[1], 'hex').toString('utf8'); } catch { return null; } }
  m = /password:\s*"((?:[^"\\]|\\.)*)"/.exec(text || '');
  if (m) return m[1].replace(/\\(.)/g, '$1');
  return null;
}
// 'translate' backend: the login keychain IS reachable but the local `security`
// is an OLDER build missing some of CC's flags (-U/-X/-w). We drive the REAL
// keychain, choosing per operation the BEST flag this version actually supports
// (detected in _kcDetect → _kcCaps), so every point on the Tiger→Tahoe spectrum
// uses its best available path — e.g. -X (hex, no argv exposure) when present,
// falling to -p (token visible in `ps` — a transient exposure, acceptable only
// as a last resort) only where -X is absent. NOT fidelity; UNTESTED until a
// headful old-macOS box is available.
function _kcHandleTranslate(args) {
  const c = _kcCaps || {};
  const sub = args[0];
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  if (sub === 'show-keychain-info') return { stdout: '', code: 36 }; // old build returns 0, not CC's expected 36
  const acct = val('-a'), svc = val('-s');
  if (sub === 'find-generic-password') {
    if (c.canW) {
      const r = _kcRealSec(['find-generic-password', '-a', acct, '-w', '-s', svc]);
      if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.length) return { stdout: r.stdout, code: 0 };
      return { stdout: '', code: 44 };
    }
    const r = _kcRealSec(['find-generic-password', '-a', acct, '-s', svc, '-g']);
    if (!r || r.status !== 0) return { stdout: '', code: 44 };
    const pw = _kcParseG((r.stderr || '') + (r.stdout || ''));
    if (pw == null) return { stdout: '', code: 44 };
    return { stdout: pw + '\n', code: 0 }; // present on stdout as CC's -w expects
  }
  if (sub === 'add-generic-password') {
    const hex = val('-X');
    const passArg = (c.canX && hex != null)
      ? ['-X', hex]                                                             // best: hex, no argv exposure
      : ['-p', hex != null ? Buffer.from(hex, 'hex').toString('utf8') : (val('-w') || val('-p') || '')];
    let sargs;
    if (c.canU) sargs = ['add-generic-password', '-U', '-a', acct, '-s', svc, ...passArg];
    else { if (c.canDelete) _kcRealSec(['delete-generic-password', '-a', acct, '-s', svc]); sargs = ['add-generic-password', '-a', acct, '-s', svc, ...passArg]; }
    const r = _kcRealSec(sargs);
    return { stdout: '', code: (r && r.status === 0) ? 0 : (r ? r.status : 1) };
  }
  if (sub === 'delete-generic-password') { if (c.canDelete) _kcRealSec(['delete-generic-password', '-a', acct, '-s', svc]); return { stdout: '', code: 0 }; }
  return null;
}
// Probe the LOCAL `security` once: is the keychain reachable, and which of CC's
// flags does this version support? Returns a capability record; a throwaway item
// is written/read/deleted with progressively older flags so each is tested
// independently (handles the whole Tiger→Tahoe spectrum, not just the endpoints).
function _kcDetect() {
  const A = '__clode_kc_probe__', S = 'clode-keychain-probe';
  try {
    _kcRealSec(['delete-generic-password', '-a', A, '-s', S]); // clean slate
    // WRITE: prefer -X (hex); fall back to -p (plaintext). Failure of both ⇒ unreachable.
    let canX = false;
    let w = _kcRealSec(['add-generic-password', '-a', A, '-s', S, '-X', '636c6f6465']);
    if (w && w.status === 0) canX = true;
    else { w = _kcRealSec(['add-generic-password', '-a', A, '-s', S, '-p', 'clode']); }
    if (!w || w.status !== 0) return { reachable: false };
    // READ: prefer -w (stdout); fall back to -g (stderr, parsed).
    let canW = false, canG = false;
    let r = _kcRealSec(['find-generic-password', '-a', A, '-w', '-s', S]);
    if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.indexOf('clode') >= 0) canW = true;
    if (!canW) { r = _kcRealSec(['find-generic-password', '-a', A, '-s', S, '-g']); if (r && r.status === 0 && _kcParseG((r.stderr || '') + (r.stdout || '')) === 'clode') canG = true; }
    if (!canW && !canG) { _kcRealSec(['delete-generic-password', '-a', A, '-s', S]); return { reachable: false }; } // wrote but unreadable ⇒ treat as unusable
    // UPDATE via -U, and whether delete-generic-password exists (for the no-U path).
    const u = _kcRealSec(['add-generic-password', '-U', '-a', A, '-s', S, '-X', '7570']);
    const canU = !!(u && u.status === 0);
    const d = _kcRealSec(['delete-generic-password', '-a', A, '-s', S]);
    const canDelete = !!(d && d.status === 0);
    return { reachable: true, canX, canW, canG, canU, canDelete };
  } catch { return { reachable: false }; }
}
function _kcProbe() {
  _kcCaps = _kcDetect();
  if (!_kcCaps.reachable) return 'emulate';                          // headless/locked: file store
  if (_kcCaps.canX && _kcCaps.canW && _kcCaps.canU) return 'passthrough'; // modern: leave CC untouched
  return 'translate';                                                // in-between: adapt per-flag
}
function _kcFakeChild(stdout, code) {
  const child = new EventEmitter();
  child.pid = -1;
  const outR = new Readable({ read() {} });
  if (stdout) outR.push(Buffer.from(stdout));
  outR.push(null);
  const errR = new Readable({ read() {} }); errR.push(null);
  child.stdout = outR; child.stderr = errR;
  child.stdin = { writable: true, write() { return true; }, end() { return this; }, on() { return this; }, once() { return this; }, destroy() { return this; }, emit() {} };
  child.kill = () => true; child.ref = () => {}; child.unref = () => {};
  child.exitCode = null; child.signalCode = null;
  queueMicrotask(() => { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); });
  return child;
}
function _kcSyncResult(stdout, code, enc) {
  const outBuf = Buffer.from(stdout || '');
  const out = (enc && enc !== 'buffer') ? outBuf.toString(enc) : outBuf;
  const err = (enc && enc !== 'buffer') ? '' : Buffer.alloc(0);
  return { pid: -1, status: code, signal: null, stdout: out, stderr: err, output: [null, out, err] };
}
function _kcMaybe(file, args, opts, sync) {
  if (opts && opts.__kcBypass) return null;
  const kcArgs = _kcSecurityArgs(file, args, opts);
  if (!kcArgs) return null;
  if (_kcMode === undefined) _kcMode = _kcProbe();
  if (_kcMode === 'passthrough') return null;
  const em = (_kcMode === 'translate') ? _kcHandleTranslate(kcArgs) : _kcHandleFile(kcArgs);
  if (!em) return null;
  trace('keychain', _kcMode, kcArgs[0]);
  return sync ? _kcSyncResult(em.stdout, em.code, opts.encoding) : _kcFakeChild(em.stdout, em.code);
}
// ---- end quaude headless-macOS keychain enhancement --------------------------

function spawn(file, args = [], opts = {}) {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  { const _kc = _kcMaybe(file, args, opts, false); if (_kc) return _kc; }
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
    proc = tjs.spawn([resolveExe(file, env || process.env), ...args], {
      cwd: opts.cwd, env, stdin: stdio.stdin, stdout: stdio.stdout, stderr: stdio.stderr,
      windowsVerbatimArguments: winVerbatim,
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
  child.kill = (sig) => { try { proc.kill(sig); return true; } catch { return false; } };
  child.ref = () => {}; child.unref = () => {};
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
function spawnSync(file, args = [], opts = {}) {
  if (!Array.isArray(args)) { opts = args || {}; args = []; }
  { const _kc = _kcMaybe(file, args, opts, true); if (_kc) return _kc; }
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

// exec/execSync run a command string through the shell, mirroring node
// (cmd.exe on Windows via applyShell, /bin/sh on POSIX). Delegate {shell:true}
// through so applyShell runs ONCE inside spawn/spawnSync — pre-resolving here
// and re-entering spawn drops the win __winVerbatim flag (cmd /c must stay
// verbatim; a double applyShell re-quotes it).
function exec(command, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return execFile(command, [], { ...(opts || {}), shell: true }, cb);
}
function execSync(command, opts) {
  return execFileSync(command, [], { ...(opts || {}), shell: true });
}

module.exports = { spawn, spawnSync, execFile, execFileSync, exec, execSync };

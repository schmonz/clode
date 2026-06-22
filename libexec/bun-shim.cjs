// bun-shim.cjs — first-party Bun-global shim for running Claude Code under Node.
// SOURCE, hand-maintained (not generated). Emulates the Bun global API surface
// the extracted bundle uses: spawn/which/hash/semver/spawn, bun:ffi, ws, etc.
//
// Versioning: one stable shim tracks the Bun *API* generation, independent of any
// Claude release. If a future Claude version needs shim behavior that conflicts
// with an older one, introduce bun-shim-<ver>.cjs and select it where the launcher
// stages the per-version cache copy. Until that divergence is observed, keep one.
//
// Changelog (append one line per upstream bump that required a shim change):
//   2026-06-xx  initial surface: spawn, which, hash(FNV), semver, bun:ffi, ws-stub
//   2026-06-22  undici stub for the proxy path; real proxying via Node NODE_USE_ENV_PROXY

'use strict';
/*
 * Minimal `Bun` global shim so the extracted Claude Code cli.cjs runs under Node >=18.
 * First pass: implements the cheap utilities; stubs the heavy ones (Terminal/
 * Transpiler/FFI) so we can boot and then fill them in against a real Node.
 * Every property exists so the module body never trips on `Bun.X is undefined`
 * at load time — unimplemented features fail only when actually exercised.
 */
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const v8 = require('v8');
const path = require('path');

// --- node:fs compatibility for Bun's readSync extension ----------------------
// Bun extends fs.readSync to accept an options object and ALLOCATE the buffer:
//   const {buffer, bytesRead} = fs.readSync(fd, {length: 4096});
// Node's fs.readSync only takes (fd, buffer, offset, length, position) and
// throws on a plain-object 2nd arg. The bundle relies on the Bun form for
// synchronous fd reads (file encoding/BOM detection AND reading terminal
// capability-query responses from stdin at TUI startup) — without this the
// interactive TUI hangs forever waiting on a read that can never complete.
// Patch the fs singleton once, here, before the cli body runs.
const _readSync = fs.readSync;
fs.readSync = function (fd, bufferOrOpts, ...rest) {
  if (rest.length === 0 && bufferOrOpts && typeof bufferOrOpts === 'object'
      && !ArrayBuffer.isView(bufferOrOpts) && !Buffer.isBuffer(bufferOrOpts)
      && typeof bufferOrOpts.length === 'number') {
    const off = bufferOrOpts.offset || 0;
    const len = bufferOrOpts.length;
    const pos = typeof bufferOrOpts.position === 'number' ? bufferOrOpts.position : null;
    const buffer = bufferOrOpts.buffer || Buffer.alloc(off + len);
    const bytesRead = _readSync(fd, buffer, off, len, pos);
    return { buffer, bytesRead };
  }
  return _readSync.call(this, fd, bufferOrOpts, ...rest);
};

// Throwing stub, tagged so the coverage report (inspect-claude-bundle
// --coverage) can tell "provided but unimplemented" from a real implementation.
const TODO = (name) => { const f = () => { throw new Error(`Bun.${name} not yet implemented in the Node host shim`); }; f.__bunShimStub = true; return f; };

// --- text utils (first-party, no deps; correctness pinned by test/text-format.test.cjs) ---
// stripANSI removes both CSI (ESC [ ... letter) and OSC (ESC ] ... BEL|ST) sequences;
// an OSC leak (hyperlinks, window titles) would otherwise show as raw text in the TUI.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function stripANSI(s){ return String(s).replace(ANSI, ''); }

// Display width of a single code point. Zero-width (combining marks, joiners,
// bidi/format controls, variation selectors) -> 0; wide CJK/emoji -> 2; else 1.
// Over-counting zero-width chars used to drift boxes/columns to the right.
function isZeroWidth(c){
  return c === 0x00AD ||                     // soft hyphen
    (c >= 0x0300 && c <= 0x036F) ||          // combining diacritical marks
    (c >= 0x0483 && c <= 0x0489) ||          // combining (Cyrillic)
    (c >= 0x0591 && c <= 0x05BD) ||          // Hebrew points
    (c >= 0x0610 && c <= 0x061A) ||          // Arabic marks
    (c >= 0x064B && c <= 0x065F) || c === 0x0670 ||
    (c >= 0x06D6 && c <= 0x06DC) ||
    (c >= 0x1AB0 && c <= 0x1AFF) ||          // combining diacritical marks extended
    (c >= 0x1DC0 && c <= 0x1DFF) ||          // combining diacritical marks supplement
    (c >= 0x200B && c <= 0x200F) ||          // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (c >= 0x202A && c <= 0x202E) ||          // bidi embeddings/overrides
    (c >= 0x2060 && c <= 0x2064) ||          // word joiner & invisible operators
    (c >= 0x20D0 && c <= 0x20FF) ||          // combining marks for symbols
    (c >= 0xFE00 && c <= 0xFE0F) ||          // variation selectors
    (c >= 0xFE20 && c <= 0xFE2F) ||          // combining half marks
    c === 0xFEFF;                            // ZWNBSP / BOM
}
function isWide(c){
  return (c>=0x1100&&c<=0x115F)||(c>=0x2E80&&c<=0xA4CF)||(c>=0xAC00&&c<=0xD7A3)||
    (c>=0xF900&&c<=0xFAFF)||(c>=0xFE30&&c<=0xFE4F)||(c>=0xFF00&&c<=0xFF60)||
    (c>=0xFFE0&&c<=0xFFE6)||(c>=0x1F300&&c<=0x1FAFF)||(c>=0x20000&&c<=0x3FFFD);
}
function charWidth(c){
  if (c === 0 || isZeroWidth(c)) return 0;
  return isWide(c) ? 2 : 1;
}
function stringWidth(s){
  s = stripANSI(String(s));
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

// --- wrapAnsi: ANSI-aware word wrap to `columns`. Wraps at spaces, hard-breaks
// words longer than the width, preserves explicit newlines, and re-opens the
// active SGR style at the start of each wrapped line (closing it at the end) so
// color never bleeds across — or gets dropped at — a break. (s)=>s never wrapped.
// Whitespace is preserved verbatim (leading, trailing, runs) EXCEPT the single
// separator consumed at a forced wrap; text that fits returns byte-for-byte
// unchanged. Losing whitespace here desynced the input editor's cursor math from
// what it rendered, which crashed the TUI on indented / multi-space input. ---
const SGR_ONLY = /^\x1b\[[0-9;]*m$/;
const ESC_AT = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~])/;
function nextActive(active, esc){
  if (!SGR_ONLY.test(esc)) return active;     // only SGR styles carry across lines
  const params = esc.slice(2, -1);            // between ESC[ and m
  return (params === '' || params === '0') ? '' : active + esc;  // reset clears
}
function wrapLine(line, columns){
  // Tokenize into alternating word / whitespace runs; escapes attach to the
  // current token. Spaces become their own tokens so they survive intact unless
  // dropped as the separator at a wrap point.
  const tokens = [];
  let tok = null;
  for (let i = 0; i < line.length;){
    if (line[i] === '\x1b'){
      const m = ESC_AT.exec(line.slice(i));
      // Escapes bind to a WORD token, never to a whitespace run: a span that
      // opens just after a space (`...word ESC[7mword`) must travel with the
      // upcoming word. Otherwise the separator space carries the style, and
      // dropping that space at a wrap leaks the next span's color (and a stray
      // reset) onto the END of the previous line — misplaced TUI highlighting.
      if (m){
        if (!tok || tok.space){ if (tok) tokens.push(tok); tok = { str: '', w: 0, escs: [], space: false }; }
        tok.str += m[0]; tok.escs.push(m[0]); i += m[0].length; continue;
      }
    }
    const cp = line.codePointAt(i), ch = String.fromCodePoint(cp), isSp = ch === ' ';
    if (!tok || tok.space !== isSp){ if (tok) tokens.push(tok); tok = { str: '', w: 0, escs: [], space: isSp }; }
    tok.str += ch; tok.w += charWidth(cp);
    i += ch.length;
  }
  if (tok) tokens.push(tok);

  const result = [];
  let cur = '', curW = 0, active = '', content = false, pending = null;  // pending = deferred space run
  const flush = () => { result.push(cur + (active ? '\x1b[0m' : '')); cur = ''; curW = 0; content = false; };
  const applyEscs = (t) => { for (const e of t.escs) active = nextActive(active, e); };
  for (const t of tokens){
    if (t.space){ pending = t; continue; }               // hold separators until we know the next word fits
    const sepW = pending ? pending.w : 0;
    if (t.w <= columns){
      if (content && curW + sepW + t.w > columns){        // word won't fit: wrap, dropping the separator
        if (pending){ applyEscs(pending); pending = null; }
        flush(); cur = active;
      } else if (pending){                                // separator (or leading space) kept
        cur += pending.str; curW += pending.w; applyEscs(pending); pending = null;
      }
      cur += t.str; curW += t.w; content = true; applyEscs(t);
    } else {                                              // overlong word: keep separator if it fits, then hard-break
      if (pending){
        if (curW + pending.w <= columns){ cur += pending.str; curW += pending.w; content = true; }
        applyEscs(pending); pending = null;
      }
      for (let i = 0; i < t.str.length;){
        if (t.str[i] === '\x1b'){
          const m = ESC_AT.exec(t.str.slice(i));
          if (m){ cur += m[0]; active = nextActive(active, m[0]); i += m[0].length; continue; }
        }
        const cp = t.str.codePointAt(i), ch = String.fromCodePoint(cp), cw = charWidth(cp);
        if (content && curW + cw > columns){ flush(); cur = active; }
        cur += ch; curW += cw; if (cw > 0) content = true;
        i += ch.length;
      }
    }
  }
  if (pending){ cur += pending.str; applyEscs(pending); }  // trailing whitespace stays on the last line
  flush();
  return result.join('\n');
}
function wrapAnsi(str, columns){
  columns = columns > 0 ? columns : 80;
  return String(str).split('\n').map((l) => wrapLine(l, columns)).join('\n');
}

// --- hashing: Bun.hash default = Wyhash64 (returns BigInt). TODO: exact wyhash if values
//     must match data produced elsewhere; FNV-1a is a stable stand-in for in-process keys. ---
function hash(input, seed){
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  let h = 1469598103934665603n ^ (BigInt(seed||0) & 0xffffffffffffffffn);
  const P = 1099511628211n, M = (1n<<64n)-1n;
  for (let i=0;i<buf.length;i++){ h = ((h ^ BigInt(buf[i])) * P) & M; }
  return h;
}
hash.wyhash = hash; hash.crc32 = (b)=>{ const z=require('zlib'); return z.crc32 ? z.crc32(b) : 0; };

// --- spawn: approximate Bun.spawn -> Node child_process ---
function spawn(cmdOrOpts, maybeOpts){
  let cmd, opts;
  if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts||{}; }
  else { opts = cmdOrOpts||{}; cmd = opts.cmd; }
  const exe = cmd[0];
  const env = opts.env || process.env;
  // Bun resolves the executable synchronously and THROWS if it isn't found, so
  // the cli's try/catch fallbacks engage. Node's cp.spawn instead emits an async
  // 'error' and never 'exit' — which makes `await proc.exited` hang FOREVER and
  // (with no 'error' listener) crashes the process. This froze the interactive
  // TUI when it spawned `rg` (ripgrep, bundled in the native binary) and rg was
  // absent from the host PATH. Match Bun: throw synchronously on a missing exe.
  if (exe && !String(exe).includes('/')) {
    if (!which(exe, { PATH: env.PATH })) throw new Error(`Executable not found in $PATH: "${exe}"`);
  } else if (exe) {
    try { fs.accessSync(exe, fs.constants.X_OK); }
    catch (_) { throw new Error(`Executable not found: "${exe}"`); }
  }
  const child = cp.spawn(exe, cmd.slice(1), {
    cwd: opts.cwd, env,
    stdio: [ opts.stdin==='inherit'?'inherit':'pipe',
             opts.stdout==='inherit'?'inherit':'pipe',
             opts.stderr==='inherit'?'inherit':'pipe' ],
  });
  // Resolve exited on BOTH 'exit' and 'error' so a late spawn failure can never
  // hang an awaiter or crash via an unhandled 'error' event.
  const exited = new Promise((res)=>{
    let done = false; const fin = (c)=>{ if(!done){ done=true; res(c); } };
    child.on('exit', (code)=>fin(code??0));
    child.on('error', ()=>fin(1));
  });
  return {
    pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    exited, kill: (s)=>child.kill(s), get exitCode(){ return child.exitCode; },
    ref(){}, unref(){ child.unref(); },
  };
}
spawn.sync = function(cmdOrOpts){
  const cmd = Array.isArray(cmdOrOpts)?cmdOrOpts:(cmdOrOpts.cmd);
  const r = cp.spawnSync(cmd[0], cmd.slice(1), {encoding:'buffer'});
  return { exitCode: r.status??0, stdout: r.stdout||Buffer.alloc(0), stderr: r.stderr||Buffer.alloc(0), success: (r.status===0) };
};

function which(bin, opts){
  const PATH = (opts&&opts.PATH)||process.env.PATH||'';
  for (const dir of PATH.split(path.delimiter)){
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch(_){}
  }
  return null;
}

// --- semver: lean on npm `semver` if resolvable, else a small comparator ---
let _semver; try { _semver = require('semver'); } catch(_){}
const semver = {
  satisfies: (v,r)=> _semver ? _semver.satisfies(v,r) : false,
  order: (a,b)=> _semver ? _semver.compare(a,b) : (a<b?-1:a>b?1:0),
};

function JSONL(text){ return String(text).split('\n').filter(Boolean).map(l=>JSON.parse(l)); }

let _yaml; try { _yaml = require('yaml'); } catch(_){}
const YAML = {
  parse: (s)=> _yaml ? _yaml.parse(s) : (()=>{throw new Error('Bun.YAML needs the `yaml` package');})(),
  stringify: (o)=> _yaml ? _yaml.stringify(o) : (()=>{throw new Error('Bun.YAML needs the `yaml` package');})(),
};

const Bun = {
  version: process.versions.bun || '1.4.0',
  revision: '0000000000000000000000000000000000000000',
  main: require.main && require.main.filename,
  env: process.env,
  argv: process.argv,
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,

  stripANSI, stringWidth, wrapAnsi,
  hash, which, spawn, semver, JSONL, YAML,
  deepEquals: (a,b)=> require('util').isDeepStrictEqual(a,b),
  gc: ()=> { if (global.gc) global.gc(); },
  generateHeapSnapshot: ()=> { try { return v8.getHeapSnapshot(); } catch(_){ return {}; } },

  // assets embedded in __BUN — none when running as loose JS. Returning [] makes the
  // app take its on-disk path. TODO: if a feature needs an embedded asset, supply it.
  embeddedFiles: [],

  // --- heavy / not-yet-done ---
  Terminal: TODO('Terminal'),        // PTY for the TUI — likely needs node-pty
  Transpiler: Object.assign(
    function(){ throw new Error('Bun.Transpiler not yet implemented (runtime TS) — consider esbuild/sucrase'); },
    { __bunShimStub: true }),
  listen: TODO('listen'),            // net.createServer wrapper
  serve: TODO('serve'),
  file: TODO('file'),
  write: TODO('write'),
  spawnSync: spawn.sync,
};

// --- bun: builtin module resolution ---------------------------------------
// The cli does `require("bun:ffi")` at runtime; Node can't resolve `bun:*`.
// Install a Module._load hook so any `bun:` request returns a shim object.
// `bun:ffi` throws on use (all known call sites are macOS spawn niceties wrapped
// in try/catch — execve / posix_spawnattr TCC disclaim — so throwing engages the
// fallback). This side-effect runs when bun-shim is required, which the extractor
// prelude does before the cli body executes, so it is active before any bun: require.
const Module = require('module');
const BUN_BUILTINS = {
  'bun:ffi': {
    dlopen() { throw new Error('bun:ffi.dlopen unavailable in Node host'); },
    ptr() { throw new Error('bun:ffi.ptr unavailable in Node host'); },
    CString: class CString {},
    FFIType: {},
    suffix: process.platform === 'darwin' ? 'dylib' : 'so',
  },
};
// External npm modules the bundle require()s at runtime that Bun resolves but
// the Node host may not have. A missing one is SILENT and fatal: it rejects in a
// render-gating promise and the interactive TUI hangs with a blank screen
// (this happened with `ws`). Provide host stubs so startup can never hang on a
// missing module. We prefer the REAL module if it's installed; the stub is only
// a fallback. Stubs are tagged __hostStub so the coverage report can flag them.
const { EventEmitter } = require('events');
class HostWebSocket extends EventEmitter {
  // client stub: constructs but never connects; both ws (.on) and DOM
  // (.addEventListener/.onopen) shapes are no-ops so callers don't throw.
  constructor(url) { super(); this.url = url; this.readyState = 0; }
  send() {} close() {} ping() {} pong() {} terminate() {}
  addEventListener() {} removeEventListener() {}
}
HostWebSocket.CONNECTING = 0; HostWebSocket.OPEN = 1; HostWebSocket.CLOSING = 2; HostWebSocket.CLOSED = 3;
const wsStub = HostWebSocket;
wsStub.WebSocket = HostWebSocket;
wsStub.default = HostWebSocket;
wsStub.WebSocketServer = class WebSocketServer extends EventEmitter {};
wsStub.Server = wsStub.WebSocketServer;
wsStub.__hostStub = true;
// undici: Node bundles undici internally but doesn't expose the bare module, and
// the bundle's proxy path does require("undici").setGlobalDispatcher(new
// EnvHttpProxyAgent(...)). We don't reimplement undici — real proxying is delegated
// to Node via NODE_USE_ENV_PROXY (the clode launcher sets it). This stub only keeps
// the proxy-setup code from throwing: every member is a no-op, callable AND newable.
const _undiciNoop = new Proxy(function () {}, {
  get: () => _undiciNoop,
  apply: () => undefined,
  construct: () => ({}),
});
const undiciStub = new Proxy({ __hostStub: true }, {
  get(_t, prop) {
    if (prop === '__hostStub') return true;
    if (prop === '__esModule') return false;
    if (prop === 'default') return undiciStub;
    return _undiciNoop;
  },
});
const HOST_MODULES = { ws: wsStub, undici: undiciStub };

const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(BUN_BUILTINS, request)) return BUN_BUILTINS[request];
  if (Object.prototype.hasOwnProperty.call(HOST_MODULES, request)) {
    try { return _load.call(this, request, parent, isMain); }   // prefer a real install
    catch (_) { return HOST_MODULES[request]; }                 // else the host stub
  }
  return _load.call(this, request, parent, isMain);
};

module.exports = Bun;
module.exports.__bunFFI = BUN_BUILTINS['bun:ffi'];
module.exports.__hostModules = Object.keys(HOST_MODULES);   // external npm modules we stub
module.exports.__bunBuiltins = Object.keys(BUN_BUILTINS);   // bun: modules we resolve
globalThis.Bun = globalThis.Bun || module.exports;   // ensure global even if required directly

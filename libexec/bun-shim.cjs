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
// Code points that are emoji-presentation by Unicode default. NOTE: conservative
// terminals (old iTerm2, *BSD consoles — clode's targets) still render a lone one
// at width 1 and only widen it with an explicit VS16. So this set does NOT force
// width 2 on its own; it only seeds isEmojiBase() as VS16-promotable. (A "modern"
// Unicode-9-width terminal would want these at 2 — that's the terminal's call.)
function isEmojiPresentation(c){
  return (c>=0x231A&&c<=0x231B)||(c>=0x23E9&&c<=0x23EC)||c===0x23F0||c===0x23F3||
    (c>=0x25FD&&c<=0x25FE)||(c>=0x2614&&c<=0x2615)||(c>=0x2648&&c<=0x2653)||
    c===0x267F||c===0x2693||c===0x26A1||(c>=0x26AA&&c<=0x26AB)||
    (c>=0x26BD&&c<=0x26BE)||(c>=0x26C4&&c<=0x26C5)||c===0x26CE||c===0x26D4||
    c===0x26EA||(c>=0x26F2&&c<=0x26F3)||c===0x26F5||c===0x26FA||c===0x26FD||
    c===0x2705||(c>=0x270A&&c<=0x270B)||c===0x2728||c===0x274C||c===0x274E||
    (c>=0x2753&&c<=0x2755)||c===0x2757||(c>=0x2795&&c<=0x2797)||c===0x27B0||
    c===0x27BF||(c>=0x2B1B&&c<=0x2B1C)||c===0x2B50||c===0x2B55||
    c===0x1F004||c===0x1F0CF||c===0x1F18E||(c>=0x1F191&&c<=0x1F19A)||
    (c>=0x1F1E6&&c<=0x1F1FF)||c===0x1F201||c===0x1F21A||c===0x1F22F||
    (c>=0x1F232&&c<=0x1F236)||(c>=0x1F238&&c<=0x1F23A)||(c>=0x1F250&&c<=0x1F251);
}
// Emoji that DEFAULT to text presentation (one column) but switch to emoji
// presentation — two columns — when followed by VS16 (U+FE0F): ⚠️ ☀️ ▶️.
// Gated to the symbol blocks so a stray VS16 after ordinary text (a️) is ignored.
function isEmojiBase(c){
  return c===0x00A9||c===0x00AE||c===0x203C||c===0x2049||c===0x2122||c===0x2139||
    (c>=0x2190&&c<=0x21FF)||(c>=0x2300&&c<=0x23FF)||(c>=0x2460&&c<=0x24FF)||
    (c>=0x25A0&&c<=0x27BF)||c===0x2934||c===0x2935||(c>=0x2B00&&c<=0x2BFF)||
    c===0x3030||c===0x303D||c===0x3297||c===0x3299||isEmojiPresentation(c);
}
// `next` is the following code point (for VS16 lookahead); 0/undefined at end.
function charWidth(c, next){
  if (c === 0 || isZeroWidth(c)) return 0;
  if (next === 0xFE0F && isEmojiBase(c)) return 2;   // VS16 forces emoji width 2
  return isWide(c) ? 2 : 1;                           // lone BMP symbols stay width 1
}
function stringWidth(s){
  s = stripANSI(String(s));
  const cps = [];
  for (const ch of s) cps.push(ch.codePointAt(0));
  let w = 0;
  for (let i = 0; i < cps.length; i++) w += charWidth(cps[i], cps[i + 1]);
  return w;
}

// --- wrapAnsi: faithful port of the `wrap-ansi` algorithm (which Bun.wrapAnsi
// mirrors), wired to OUR stringWidth/stripANSI so wrapping and width-measuring
// share ONE width function — the property that makes native's wraps and the
// renderer's inline-code highlight positions line up. Honors the {trim, hard,
// wordWrap} options the renderer and editor pass; the previous hand-rolled version
// ignored the options and dropped wrap-boundary whitespace, which drifted TUI
// highlights. SGR/OSC is closed before each inserted newline and reopened after,
// via the ansi-styles open->close map (single active code, exactly like wrap-ansi).
// (We don't .normalize() the input the way wrap-ansi does, to keep the input
// editor's byte-for-byte cursor math intact; the renderer feeds NFC text already.)
const ESCAPES = new Set(['', '']);
const A_BELL = '', A_LINK = ']8;;', FG_RESET = 39;
const sgrCode = (code) => `[${code}m`;
const sgrLink = (url) => `${A_LINK}${url}${A_BELL}`;
// open SGR code -> its reset code (the slice of ansi-styles `.codes` we need)
const SGR_RESET = new Map([[1, 22], [2, 22], [3, 23], [4, 24], [7, 27], [8, 28], [9, 29], [53, 55]]);
for (let c = 30; c <= 37; c++) SGR_RESET.set(c, 39);
for (let c = 90; c <= 97; c++) SGR_RESET.set(c, 39);
for (let c = 40; c <= 47; c++) SGR_RESET.set(c, 49);
for (let c = 100; c <= 107; c++) SGR_RESET.set(c, 49);

// Break a single word too long for `columns`, ANSI-aware (escapes count zero).
function wrapWord(rows, word, columns){
  const chars = [...word];
  let inEscape = false, inLink = false;
  let visible = stringWidth(stripANSI(rows[rows.length - 1]));
  for (let i = 0; i < chars.length; i++){
    const ch = chars[i], w = stringWidth(ch);
    if (visible + w <= columns) rows[rows.length - 1] += ch;
    else { rows.push(ch); visible = 0; }
    if (ESCAPES.has(ch)){ inEscape = true; inLink = chars.slice(i + 1).join('').startsWith(A_LINK); }
    if (inEscape){
      if (inLink){ if (ch === A_BELL){ inEscape = false; inLink = false; } }
      else if (ch === 'm'){ inEscape = false; }
      continue;
    }
    visible += w;
    if (visible === columns && i < chars.length - 1){ rows.push(''); visible = 0; }
  }
  if (!visible && rows[rows.length - 1].length > 0 && rows.length > 1) rows[rows.length - 2] += rows.pop();
}

// Trim trailing spaces from a row without disturbing ANSI escapes.
function trimRowRight(s){
  const words = s.split(' ');
  let last = words.length;
  while (last > 0 && stringWidth(words[last - 1]) === 0) last--;
  return last === words.length ? s : words.slice(0, last).join(' ') + words.slice(last).join('');
}

function wrapAnsiLine(string, columns, options){
  if (options.trim !== false && string.trim() === '') return '';
  const words = string.split(' ');
  const lengths = words.map((w) => stringWidth(w));
  let rows = [''];
  for (let index = 0; index < words.length; index++){
    const word = words[index];
    if (options.trim !== false) rows[rows.length - 1] = rows[rows.length - 1].trimStart();
    let rowLength = stringWidth(rows[rows.length - 1]);
    if (index !== 0){
      if (rowLength >= columns && (options.wordWrap === false || options.trim === false)){ rows.push(''); rowLength = 0; }
      if (rowLength > 0 || options.trim === false){ rows[rows.length - 1] += ' '; rowLength++; }
    }
    if (options.hard && lengths[index] > columns){
      const remaining = columns - rowLength;
      const breaksThis = 1 + Math.floor((lengths[index] - remaining - 1) / columns);
      const breaksNext = Math.floor((lengths[index] - 1) / columns);
      if (breaksNext < breaksThis) rows.push('');
      wrapWord(rows, word, columns);
      continue;
    }
    if (rowLength + lengths[index] > columns && rowLength > 0 && lengths[index] > 0){
      if (options.wordWrap === false && rowLength < columns){ wrapWord(rows, word, columns); continue; }
      rows.push('');
    }
    if (rowLength + lengths[index] > columns && options.wordWrap === false && !options.hard){ wrapWord(rows, word, columns); continue; }
    rows[rows.length - 1] += word;
  }
  if (options.trim !== false) rows = rows.map(trimRowRight);

  // Reconstruct style across the inserted newlines: close the active SGR/OSC before
  // each '\n' and reopen it after. Single active code, exactly like wrap-ansi.
  const pre = rows.join('\n');
  const cps = [...pre];
  let out = '', active, activeUrl, idx = 0;
  for (let i = 0; i < cps.length; i++){
    const ch = cps[i];
    out += ch;
    if (ESCAPES.has(ch)){
      const m = /(?:\[(\d+)m|\]8;;(.*?))/.exec(pre.slice(idx));
      if (m){
        if (m[1] !== undefined){ const c = Number(m[1]); active = c === FG_RESET ? undefined : c; }
        else if (m[2] !== undefined){ activeUrl = m[2].length === 0 ? undefined : m[2]; }
      }
    }
    const reset = SGR_RESET.get(Number(active));
    if (cps[i + 1] === '\n'){
      if (activeUrl) out += sgrLink('');
      if (active && reset) out += sgrCode(reset);
    } else if (ch === '\n'){
      if (active && reset) out += sgrCode(active);
      if (activeUrl) out += sgrLink(activeUrl);
    }
    idx += ch.length;
  }
  return out;
}

function wrapAnsi(string, columns, options){
  columns = columns > 0 ? columns : 80;
  options = options || {};
  return String(string).replace(/\r\n/g, '\n').split('\n')
    .map((line) => wrapAnsiLine(line, columns, options)).join('\n');
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

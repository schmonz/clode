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
// THE SINGLE SOURCE OF TRUTH for what this shim answers itself, before Node's or
// tjs's own resolver ever sees the request: `bun:*` pseudo-modules (intercepted
// by the Module._load hook below) and HOST_MODULES stubs. These are NOT npm
// packages quaude/naude embed, so clode's dep-closure gate must not demand them
// from the ext-dep closure — it reads THIS declaration to know that.
//
// WHY IT IS SHAPED LIKE JSON, up here, away from the implementations. The gate
// runs inside `clode build`, which must work on a machine with no node: under a
// fused native builder process.execPath IS the fused clode binary. So the gate
// can neither spawn a host to ask this file (it used to — `process.execPath -e`
// — and that broke EVERY build under clode-native) nor require() it in-process
// (requiring this file installs the Module._load hook and sets globalThis.Bun —
// machinery for a RUNNING quaude/naude, not clode's own builder). It therefore
// READS these names out of this source text with JSON.parse. Keep this literal
// JSON-shaped — double quotes, no comments, no trailing commas, no expressions —
// or that parse fails LOUD and the build stops.
//
// Declaring the NAMES here rather than deriving them from the tables below is
// deliberate: BUN_BUILTINS is assembled in two places ('bun:ffi' in its literal,
// 'bun:sqlite' attached afterward), so the names have no single readable home
// down there. Now they have one up here, the tables are keyed off it, and
// test/dep-closure.test.cjs asserts the tables and this list agree — so a
// new stub cannot appear without being declared, and this cannot drift from what
// the shim really intercepts.
const PROVIDES = {
  "bunBuiltins": ["bun:ffi", "bun:sqlite"],
  "hostModules": ["undici"]
};

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

// --- snapshot rewrite hook (child_process layer) ---------------------------
// Claude Code generates its zsh shell snapshot by building a shell SCRIPT string
// (which embeds the grep/find/rg shadow functions in heredocs) and running it via
// child_process.execFile(shell, ["-c","-l", script]). The spawned SHELL writes the
// snapshot file via redirection — node never touches it with fs.writeFile. So we
// intercept the child_process call and rewrite the embedded shadows in the command
// string before the shell runs it. Detection is gated on the snapshot signature
// (a SNAPSHOT_FILE= assignment plus an ARGV0=/exec -a shadow), so every other spawn
// passes through untouched. rewriteSnapshot throws on an unknown applet; at runtime
// we DON'T brick snapshot generation — we warn loudly and pass the original through
// (the inspect --strict gate is the build-time tripwire for new applets).
// We patch the SAME child_process object the bundle uses: `cp` above is
// require('child_process'), which Node caches, so require('node:child_process')
// and require('child_process') in the bundle resolve to this very object.
const _looksLikeSnapshotCmd = (s) =>
  typeof s === 'string' && s.indexOf('SNAPSHOT_FILE=') !== -1 && /(ARGV0=|exec -a )/.test(s);
const _rewriteSnapshotArg = (s) => {
  if (!_looksLikeSnapshotCmd(s)) return s;
  let rewritten;
  try {
    rewritten = rewriteSnapshot(s);
  } catch (e) {
    process.stderr.write(`clode: snapshot shadow rewrite skipped: ${e && e.message}\n`);
    return s;
  }
  // Rewrite succeeded: probe the host applets for flag skew (best-effort, never
  // fatal). When the probe finds skew, rebuild with the findings so the affected
  // shadows carry the self-explaining failure trailer (see buildShadow).
  try {
    const findings = warnAppletSkew(collectShadows(s));
    if (findings && findings.length) rewritten = rewriteSnapshot(s, findings);
  } catch (_) {}
  return rewritten;
};
// Rewrite any snapshot-generator command found in a child_process invocation.
// execFile/spawn family: the command string is an element of the args ARRAY (2nd arg).
// exec/execSync family: the command is the FIRST string arg.
const _rewriteArgsArray = (a) => Array.isArray(a) ? a.map(_rewriteSnapshotArg) : a;

// Unpatched spawnSync for warnAppletSkew's own applet probes, so they never
// recurse back through the snapshot-rewrite wrapper installed just below.
const _rawSpawnSync = cp.spawnSync;

for (const m of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const orig = cp[m];
  if (typeof orig !== 'function') continue;
  cp[m] = function (file, args, ...rest) {
    return orig.call(this, file, _rewriteArgsArray(args), ...rest);
  };
}
for (const m of ['exec', 'execSync']) {
  const orig = cp[m];
  if (typeof orig !== 'function') continue;
  cp[m] = function (command, ...rest) {
    return orig.call(this, _rewriteSnapshotArg(command), ...rest);
  };
}

// Throwing stub, tagged so the coverage report (inspect-claude-bundle
// --coverage) can tell "provided but unimplemented" from a real implementation.
const TODO = (name) => { const f = () => { throw new Error(`Bun.${name} not yet implemented in the Node host shim`); }; f.__bunShimStub = true; return f; };

// --- external deps backed by real npm packages -----------------------------
// stripANSI / stringWidth / wrapAnsi (and semver, below) are backed by the npm
// strip-ansi / string-width / wrap-ansi / semver packages -- no in-house clones.
// They render every frame / gate versions, so a missing one is FATAL: write the
// install hint and exit (nothing to recover, unlike the optional ws/yaml features).
// require() resolves these even though string-width/strip-ansi/wrap-ansi are ESM-
// only: Node (clode floors at 24) supports require() of ESM with no top-level await
// and returns a namespace whose `.default` is the function -- hence `.default || m`.
// (A future top-level-await release would make require() throw ERR_REQUIRE_ASYNC_
// MODULE; pin a sync version then.)
function _extMissing(pkg, feature){
  return "clode: " + feature + " needs the npm '" + pkg + "' package, which isn't installed.\n" +
    "       Install it with the same Node as clode:  npm install -g " + pkg + "\n" +
    "       (or point NODE_PATH at a node_modules dir that has it).";
}
function _extFatal(msg){ try { fs.writeSync(2, '\n' + msg + '\n'); } catch (_) {} process.exit(1); }
function _extResolve(pkg){ try { const m = require(pkg); return (m && m.default) || m; } catch (_) { return undefined; } }

const _stringWidthFn = _extResolve('string-width');
const _stripAnsiFn   = _extResolve('strip-ansi');
const _wrapAnsiFn    = _extResolve('wrap-ansi');
function stringWidth(...a){ return _stringWidthFn ? _stringWidthFn(...a) : _extFatal(_extMissing('string-width', 'text rendering (display width)')); }
function stripANSI(...a){ return _stripAnsiFn ? _stripAnsiFn(...a) : _extFatal(_extMissing('strip-ansi', 'text rendering (ANSI stripping)')); }
function wrapAnsi(...a){ return _wrapAnsiFn ? _wrapAnsiFn(...a) : _extFatal(_extMissing('wrap-ansi', 'text rendering (line wrapping)')); }
// Without the real module these are fail-loud stubs, not implementations -- tag so
// inspect-claude-bundle coverage reports them honestly (see Bun.YAML).
if (!_stringWidthFn) stringWidth.__bunShimStub = true;
if (!_stripAnsiFn) stripANSI.__bunShimStub = true;
if (!_wrapAnsiFn) wrapAnsi.__bunShimStub = true;

// --- rewriteSnapshot: rewrite Claude Code's grep/find/rg shell-snapshot shadows
// to exec the REAL host applet instead of the upstream native multiplexer (which
// under clode resolves to node / a non-dispatching binary). Same-tool routing,
// fail-loud if the applet is absent. A shadow whose applet we don't know throws
// (auto-tracking: a new upstream applet must be handled deliberately). ---
// probe(flags) -> { args, skew } describes a NO-OP invocation of the host applet
// that still PARSES the same flag list the rewritten shadow will pass it, plus a
// skew(exitCode) predicate that is true when the applet rejected those flags.
// grep-family tools exit >=2 on a usage error (1 just means "no match", not skew);
// bfs exits non-zero on any error and 0 once it hits -quit. Used by warnAppletSkew
// at snapshot-refresh to catch a host applet that's too old for the embedded one's
// flags (e.g. pkgsrc bfs 1.5.1 rejecting -regextype findutils-default).
// `fix` is the applet-specific remedy surfaced on BOTH skew surfaces (stderr and the
// /doctor Installation-warnings item). bfs is specific: Claude's `find` alias passes
// `-regextype findutils-default`, a GNU-findutils regex type bfs only provides when
// built with Oniguruma (bfs gates the GNU types behind `#if BFS_WITH_ONIGURUMA`), and
// that support landed in bfs 3.3 ("all regex types from GNU find"). A POSIX-only build
// — any version — rejects the flag, so "upgrade it" is wrong advice. ugrep/rg keep a
// generic remedy until we learn their concrete requirements.
// skewRcTest is the SHELL twin of probe().skew: the same exit-code semantics as
// a POSIX test over `$_rc`, used by buildShadow's skew trailer so a rewritten
// shadow can tell "the applet failed the way skew fails" from benign exits
// (grep/rg exit 1 = "no match"; bfs is non-zero on any error). Keep the pair in
// sync — the CLODE_SHADOWS unit test locks each twin to its predicate.
const CLODE_SHADOWS = {
  grep: { applet: 'ugrep', env: 'CLODE_UGREP',
          fix: 'set CLODE_UGREP to a compatible ugrep, or upgrade it',
          probe: (f) => ({ args: [...f, '-e', 'x', '/dev/null'], skew: (c) => c >= 2 }),
          skewRcTest: '[ "$_rc" -ge 2 ]' },
  find: { applet: 'bfs',   env: 'CLODE_BFS',
          fix: 'install bfs ≥ 3.3 built with Oniguruma, or set CLODE_BFS to such a build',
          probe: (f) => ({ args: [...f, '-quit', '.'],           skew: (c) => c !== 0 }),
          skewRcTest: '[ "$_rc" -ne 0 ]' },
  rg:   { applet: 'rg',    env: 'CLODE_RG',
          fix: 'set CLODE_RG to a compatible rg, or upgrade it',
          probe: (f) => ({ args: [...f, '--version'],            skew: (c) => c >= 2 }),
          skewRcTest: '[ "$_rc" -ge 2 ]' },
};
// A shadow body is the upstream multiplexer if it invokes an applet via argv0
// against the provider binary. We detect the applet from ARGV0=/exec -a.
const SHADOW_APPLET = /(?:ARGV0=|exec -a )([A-Za-z0-9_+-]+)\b/;

// Find the end index (exclusive) of a brace-balanced block that starts at the
// '{' at openIdx. Quote/escape aware: braces inside shell single- or
// double-quoted spans (and a backslash-escaped brace) do NOT count, so a stray
// '}' in a quoted string can't desync the match. Single quotes are fully literal
// (no escapes); double quotes honor backslash escapes; outside quotes a
// backslash escapes the next char.
function matchBrace(text, openIdx){
  let depth = 0, quote = null;  // quote: null | "'" | '"'
  for (let i = openIdx; i < text.length; i++){
    const ch = text[i];
    if (quote === "'"){
      if (ch === "'") quote = null;          // single quotes: literal, no escapes
      continue;
    }
    if (quote === '"'){
      if (ch === '\\'){ i++; continue; }     // escape next char inside double quotes
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\'){ i++; continue; }       // outside quotes: escape next char
    if (ch === "'" || ch === '"'){ quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}'){ depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Pull the applet + the flag string (between "$_cc_bin" and "$@") out of a shadow
// body, plus the optional passthrough `for _cc_a ... done` guard. Returns null if
// the body is not an upstream multiplexer shadow.
function parseShadow(body){
  const am = SHADOW_APPLET.exec(body);
  if (!am || !/_cc_bin|CLAUDE_CODE_EXECPATH|\/claude\b/.test(body)) return null;
  const applet = am[1];
  const fm = /"\$_cc_bin"\s+([\s\S]*?)\s+"\$@"/.exec(body);
  const flags = fm ? fm[1].trim() : '';
  const gm = /(\s*local _cc_a[\s\S]*?\n\s*done\n)/.exec(body);
  const guard = gm ? gm[1] : '';
  return { applet, flags, guard };
}

// Embed arbitrary text as a single shell word: single-quote it, escaping any
// embedded single quote with the classic '\'' dance. The skew `why` is the host
// applet's own stderr line, so it can contain anything.
function shQuote(s){ return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Build the replacement shadow. Without a skew finding: exec the host applet
// (fast path — the function's subshell is replaced). WITH a finding (the
// generation-time probe saw this applet reject these flags): drop the exec so
// the exit code is observable, and on a skew-shaped failure print a
// self-explaining line — the probe's exact why + the applet-specific fix — to
// stderr right where the cryptic applet error lands, then propagate the
// applet's own exit code. This is the host-applet (foundation) configuration's
// answer to skew: the diagnosis travels to the point of use, visible to the
// user and to any agent reading the failed command's output.
function buildShadow(name, known, parsed, finding){
  const { applet, env } = known;
  const flags = parsed.flags ? ' ' + parsed.flags : '';
  const head = `function ${name} {\n` +
    parsed.guard +
    `  local _bin="\${${env}:-$(command -v ${applet} 2>/dev/null)}"\n` +
    `  [ -n "$_bin" ] || { echo "clode: ${name} needs '${applet}' (set ${env} or install it)" >&2; return 127; }\n`;
  if (!finding) return head + `  exec "$_bin"${flags} "$@"\n}`;
  const msg = shQuote(
    `clode: known applet skew — host ${applet} rejects the flags this ${name} shadow uses ` +
    `(${finding.why}). ${finding.fix}.`);
  return head +
    `  "$_bin"${flags} "$@"\n` +
    `  local _rc=$?\n` +
    `  ${known.skewRcTest} && printf '%s\n' ${msg} >&2\n` +
    `  return $_rc\n` +
    `}`;
}

// Walk every `function NAME { ... }` whose body is an upstream multiplexer shadow,
// invoking cb with the parse + span. Shared by rewriteSnapshot (which rewrites the
// span) and collectShadows (which only reads it) so the two can never disagree
// about what counts as a shadow.
function _eachShadow(text, cb){
  const fnRe = /\bfunction ([A-Za-z_][A-Za-z0-9_]*) \{/g;
  let m;
  while ((m = fnRe.exec(text)) !== null){
    const name = m[1];
    const openIdx = m.index + m[0].length - 1;          // the '{'
    const endIdx = matchBrace(text, openIdx);
    if (endIdx === -1) break;
    const parsed = parseShadow(text.slice(openIdx + 1, endIdx - 1));
    if (parsed){
      cb({ name, parsed, mIndex: m.index, endIdx });
      fnRe.lastIndex = endIdx;
    }
    // non-shadow functions: leave untouched (the slice is emitted later)
  }
}

// findings (optional): skew findings from warnAppletSkew for THIS snapshot's
// shadows — a shadow with a finding is built with the self-explaining skew
// trailer instead of the exec fast path. Omitted/empty = the pure rewrite.
function rewriteSnapshot(text, findings){
  text = String(text);
  const byName = new Map((findings || []).map((f) => [f.name, f]));
  let out = '', i = 0;
  _eachShadow(text, ({ name, parsed, mIndex, endIdx }) => {
    // Body looks like an upstream multiplexer shadow.
    const known = CLODE_SHADOWS[name];
    if (!known || known.applet !== parsed.applet){
      throw new Error(`clode: unrecognized search shadow function ${name} -> ${parsed.applet}; ` +
        `update CLODE_SHADOWS in bun-shim.cjs`);
    }
    out += text.slice(i, mIndex) + buildShadow(name, known, parsed, byName.get(name));
    i = endIdx;
  });
  out += text.slice(i);
  return out;
}

// Parse (without rewriting) the known search shadows present in a snapshot, for
// the skew probe. Unknown applets are skipped here — rewriteSnapshot already
// throws on them before we ever probe.
function collectShadows(text){
  const out = [];
  _eachShadow(String(text), ({ name, parsed }) => {
    const known = CLODE_SHADOWS[name];
    if (known && known.applet === parsed.applet)
      out.push({ name, applet: known.applet, env: known.env, flags: parsed.flags });
  });
  return out;
}

// After rewriting a shadow to exec the host applet, confirm that applet actually
// ACCEPTS the flags Claude's embedded applet is invoked with. A host applet that
// skews older can reject a flag the bundle's build supports, so `find`/`grep`
// would fail at use-time with a cryptic error far from here. Probe once per
// (applet, flags) per process and warn loudly, naming the rejected flag. Absence
// of the applet is NOT skew — the rewritten shadow's own guard fails loud on that.
// Probe results memoized per (resolved bin, applet, flags): finding object when
// skew, null when the applet accepted the flags. The bin is part of the key so
// a changed CLODE_* override re-probes. The stderr warning fires once per key;
// the FINDING is returned on every call so a later snapshot generation in the
// same process still gets its shadows built with the skew trailer.
const _skewProbed = new Map();
const _skewFindings = [];
// Record a skew finding for BOTH surfaces: the loud stderr line (here, the source
// of truth — independent of any bundle patching) and globalThis.__clodeDoctor,
// which the /doctor screen (patched in by extract-claude-js) renders. The /doctor
// section is best-effort; stderr always fires, so a skew is never silently dropped.
function _recordSkew(f){
  _skewFindings.push(f);
  const g = (typeof globalThis !== 'undefined') ? globalThis : global;
  g.__clodeDoctor = g.__clodeDoctor || {};
  g.__clodeDoctor.appletSkew = _skewFindings;
}
function warnAppletSkew(shadows, spawn = _rawSpawnSync){
  const found = [];
  for (const sh of shadows){
    const known = CLODE_SHADOWS[sh.name];
    if (!known || !known.probe) continue;
    const bin = process.env[known.env] || which(known.applet);
    if (!bin) continue;
    const flags = sh.flags ? sh.flags.split(/\s+/).filter(Boolean) : [];
    const key = bin + '\0' + sh.applet + '\0' + flags.join(' ');
    if (_skewProbed.has(key)){
      const memo = _skewProbed.get(key);
      if (memo) found.push({ ...memo, name: sh.name });
      continue;
    }
    const { args, skew } = known.probe(flags);
    let r;
    try { r = spawn(bin, args, { encoding: 'utf8', timeout: 5000 }); }
    catch (_) { continue; }
    if (r.error || skew(r.status)){
      // The most informative stderr line, not merely the first: bfs prefixes its
      // real complaint with a command echo (contains the bin path) and a tilde
      // underline — skip both shapes, fall back to the first line.
      const lines = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const informative = lines.filter((l) =>
        !l.includes(bin) && !/^[~^\s]*$/.test(l.replace(/^[^:]+:\s*(error:)?\s*/i, '')));
      const why = informative[0] || lines[0]
        || (r.error && r.error.message) || `exit ${r.status}`;
      const fix = known.fix || `set ${known.env} to a compatible ${sh.applet}, or upgrade it`;
      const finding = { name: sh.name, applet: sh.applet, why, fix };
      _skewProbed.set(key, finding);
      _recordSkew(finding);
      found.push(finding);
      process.stderr.write(
        `clode: host ${sh.applet} rejects the flags Claude's embedded ${sh.applet} uses — ` +
        `\`${sh.name}\` will fail:\n` +
        `       ${why}\n` +
        `       ${fix}.\n`);
    } else {
      _skewProbed.set(key, null);
    }
  }
  return found;
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

// --- semver: backed by the npm `semver` package; fail loud if absent. (The old
// in-house numeric comparator is gone -- npm semver owns correctness, including the
// "2.1.179 > 2.1.70" Remote Control gate the original string fallback broke.) ---
let _semver; try { _semver = require('semver'); } catch(_){}
const semver = {
  satisfies: (v,r)=> _semver ? _semver.satisfies(v,r) : _extFatal(_extMissing('semver', 'version checks')),
  order: (a,b)=> _semver ? _semver.compare(a,b) : _extFatal(_extMissing('semver', 'version checks')),
};
if (!_semver) semver.__bunShimStub = true;

function JSONL(text){ return String(text).split('\n').filter(Boolean).map(l=>JSON.parse(l)); }

// Bun.YAML is backed by the npm `yaml` dep (the same ext-dep seam as `ws`). The
// bundle uses it only at feature time (skill/command/memory frontmatter) and wraps
// many parse() calls in try/catch — so a plain throw is SWALLOWED and the user never
// learns why frontmatter broke. Fail loud at point-of-use: write the actionable
// message to fd 2 ONCE (survives the caller's catch), then throw CLODE_YAML_MISSING
// so each item can still degrade per-feature. Not exit (unlike ws) — yaml is
// point-of-use, not startup-critical. Args are forwarded verbatim so Bun's
// `YAML.stringify(value, replacer, space)` reaches the real module intact.
let _yaml; try { _yaml = require('yaml'); } catch(_){}
const YAML_MISSING =
  "clode: YAML features (skill/command/memory frontmatter) need the npm 'yaml' " +
  "package, which isn't installed.\n" +
  "       Install it with the same Node as clode:  npm install -g yaml\n" +
  "       (or point NODE_PATH at a node_modules dir that has it).";
let _yamlWarned = false;
function _yamlFatal(){
  if (!_yamlWarned) { _yamlWarned = true; try { fs.writeSync(2, '\n' + YAML_MISSING + '\n'); } catch(_){} }
  const e = new Error(YAML_MISSING); e.code = 'CLODE_YAML_MISSING'; throw e;
}
const YAML = {
  parse: (...a)=> _yaml ? _yaml.parse(...a) : _yamlFatal(),
  stringify: (...a)=> _yaml ? _yaml.stringify(...a) : _yamlFatal(),
};
// Without `yaml`, Bun.YAML is a fail-loud stub, not a real implementation — tag it
// so inspect-claude-bundle's coverage reports it honestly (stubbed, not implemented).
if (!_yaml) YAML.__bunShimStub = true;

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

// bun:sqlite (Claude Code history/todos) -> node:sqlite. The Bun->Node layer of
// a two-part design (user, 2026-07-15): map Bun's SQLite API onto node:sqlite,
// which is NATIVE under the classic Node launcher and provided by
// node-shim/modules/sqlite.cjs (over tjs:sqlite) under quaude. node:sqlite is a
// rich modern API (get/all/run natively), so this mapping is thin. INLINED so
// bun-shim stays self-contained (the extractor cache + isolated-shim test copy
// bun-shim.cjs ALONE); node:sqlite is a builtin, not a sibling file. Fail-loud if
// no SQLite backend exists. Tests: test/bun-sqlite.test.cjs.
BUN_BUILTINS['bun:sqlite'] = (() => {
  let NodeDb;
  try { NodeDb = require('node:sqlite').DatabaseSync; } catch (_) { NodeDb = null; }
  const notImpl = (name) => { const f = function () { throw new Error(`bun:sqlite.${name} not yet implemented`); }; f.__bunSqliteStub = true; return f; };
  class Statement {
    constructor(s) { this._s = s; }
    all(...p) { return this._s.all(...p); }
    get(...p) { const r = this._s.get(...p); return r == null ? undefined : r; }
    values(...p) { return this._s.all(...p).map((row) => Object.values(row)); }
    run(...p) { return this._s.run(...p); }   // node:sqlite run() -> {changes,lastInsertRowid}
  }
  Statement.prototype.iterate = notImpl('Statement.iterate');
  Statement.prototype.as = notImpl('Statement.as');
  class Database {
    constructor(path) {
      if (!NodeDb) throw new Error('bun:sqlite: no node:sqlite backend in this runtime');
      this._db = new NodeDb(path);
    }
    query(sql) { return new Statement(this._db.prepare(sql)); }   // Bun caches query; node prepares
    prepare(sql) { return new Statement(this._db.prepare(sql)); }
    exec(sql) { this._db.exec(sql); }
    run(sql, ...p) { return new Statement(this._db.prepare(sql)).run(...p); }
    transaction(fn) {
      const db = this;
      return function (...a) {
        db.exec('BEGIN');
        try { const r = fn.apply(this, a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
      };
    }
    close() { this._db.close(); }
  }
  Database.prototype.serialize = notImpl('Database.serialize');
  Database.prototype.loadExtension = notImpl('Database.loadExtension');
  return { Database, default: Database };
})();
// --- WebSocket / `ws`: the bundle is written for BUN's WebSocket, which takes a
// SINGLE options object — new WebSocket(url, {protocols, headers, tls, proxy}).
// Node's global WebSocket (undici/WHATWG) ignores `headers`, so the Bearer auth
// header never goes out and Remote Control / MCP-over-WebSocket get rejected. We
// back it with the npm `ws` package (translating Bun's options to ws's
// (url, protocols, {headers,...}) form) and install it as globalThis.WebSocket.
//
// `ws` is an EXPLICIT npm dependency, not something we vendor or stub: when it
// isn't installed we FAIL LOUD at the first WebSocket use (mirroring the
// search-applet guards) rather than silently never-connecting. The seam — resolve
// the real module, else a clear "install it" error — is the shape we want for
// host-provided deps generally. ---
let _ws; try { _ws = require('ws'); } catch (_) {}
const _realWS = () => _ws && (_ws.WebSocket || _ws.default || _ws);
// Capture the engine's native WebSocket BEFORE the override below. Under tjs this
// is txiki's libwebsockets-backed WS, which (unlike Node's undici WS) accepts a
// { headers } option — the bridge's Bearer auth, the reason we wanted npm `ws`.
// Detect the engine once so BunWebSocket and the capability flag agree.
const UNDER_TJS = typeof globalThis.tjs !== 'undefined' || !!globalThis.__tjs_fs_sync;
const _nativeWS = globalThis.WebSocket;
// A usable transport: npm ws (any host), or — under tjs — the header-capable native WS.
const _wsTransportAvailable = () => !!_realWS() || (UNDER_TJS && typeof _nativeWS === 'function');
// Translate Bun's { protocols, headers, ... } to the native WS 2nd-arg options object.
function _nativeWsOptions(opts){
  if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
    const o = {};
    if (opts.headers) o.headers = opts.headers;
    if (opts.protocols) o.protocols = opts.protocols;
    return o;
  }
  if (opts !== undefined) return { protocols: opts };   // WHATWG form: 2nd arg is protocols
  return undefined;
}
const WS_MISSING =
  "clode: WebSocket features (Remote Control, MCP-over-WebSocket) need the npm 'ws' " +
  "package, which isn't installed.\n" +
  "       Install it with the same Node as clode:  npm install -g ws\n" +
  "       (or point NODE_PATH at a node_modules dir that has it).";
// A missing required ext-dep must fail LOUD and FATAL, not throw. The bundle
// require()s `ws` inside a render-gating startup promise that SWALLOWS exceptions,
// so a plain throw just hangs the interactive TUI with a blank screen (the user
// sees nothing). Write straight to fd 2 (unbuffered, survives the exit) and stop
// the process at the first point ws is needed. This is the shape we want for
// host-provided deps generally: install it, or get a clear message and a clean exit.
function _wsFatal(){ _extFatal(WS_MISSING); }
// Translate a Bun-style WebSocket constructor call into ws's (url, protocols, options).
function _wsArgs(url, opts){
  if (opts && typeof opts === 'object' && !Array.isArray(opts)){
    const options = {};
    if (opts.headers) options.headers = opts.headers;
    if (opts.tls && typeof opts.tls === 'object') Object.assign(options, opts.tls);  // ca/cert/key/rejectUnauthorized
    return [url, opts.protocols, options];
  }
  return [url, opts, undefined];                 // WHATWG form: 2nd arg is protocols
}
function BunWebSocket(url, opts){
  const WS = _realWS();
  if (WS) { const [u, p, o] = _wsArgs(url, opts); return new WS(u, p, o); }   // npm ws (Node hosts)
  if (UNDER_TJS && typeof _nativeWS === 'function') {                          // native tjs WS (header-capable)
    return new _nativeWS(url, _nativeWsOptions(opts));
  }
  _wsFatal();                                                                  // Node without ws, or no native WS
}
BunWebSocket.CONNECTING = 0; BunWebSocket.OPEN = 1; BunWebSocket.CLOSING = 2; BunWebSocket.CLOSED = 3;
// Override the global so the bundle's `new globalThis.WebSocket(url,{headers})`
// sites get header support; Node's native one would silently drop the auth header.
// Under tjs, BunWebSocket now delegates to the captured native WS (_nativeWS), which
// IS header-capable — see _nativeWsOptions above.
globalThis.WebSocket = BunWebSocket;

// Single source of truth for "this engine has no working WebSocket transport":
// false whenever a real transport resolved (npm `ws` on Node hosts, or the
// engine's native WebSocket under tjs); true only where neither exists.
// The extract-time remote-control patch (extract-claude-js.cjs) reads this
// to gate WebSocket features off with an honest notice instead of a
// swallowed async crash.
globalThis.__clodeWsUnavailable = !_wsTransportAvailable();

// A ws-shaped module for the TJS BRING-UP PATH ONLY, when the real `ws` isn't
// loadable: under the node-shim loader `ws` can't load at all yet (it needs a
// fuller tls/net than the shim provides), but the -p path merely CAPTURES it at
// module-load time (`P(require("ws"))`) and never opens a socket — so there the
// capture defers, and only CONSTRUCTING a WebSocket/Server fails loud.
// Under real Node hosting, `ws` is a REQUIRED dep (bundled-deps decision,
// BACKLOG.md "ws / bundled-deps": missing required dep = broken build): a failed
// require('ws') is fatal AT REQUIRE — a plain throw would be swallowed by the
// bundle's render-gating promise and the TUI would hang blank. Fail-loud contract
// locked by test/websocket.test.cjs; the tjs deferral by
// test/node-shim-bunshim.test.cjs.
function _wsServerFatal() { _wsFatal(); }
const _wsLazyModule = Object.assign(BunWebSocket, {
  WebSocket: BunWebSocket,
  default: BunWebSocket,
  WebSocketServer: _wsServerFatal,
  Server: _wsServerFatal,
  createWebSocketStream: _wsServerFatal,
});

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
const HOST_MODULES = { undici: undiciStub };

const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(BUN_BUILTINS, request)) return BUN_BUILTINS[request];
  // `ws` is a required host dependency: real module if installed, else fail loud
  // AT REQUIRE (no silent no-connect stub — see the WebSocket adapter above).
  // Only the tjs bring-up path defers to first USE via the lazy module.
  if (request === 'ws') {
    if (_ws) return _ws;
    if (UNDER_TJS) return _wsLazyModule;
    _wsFatal();
  }
  if (Object.prototype.hasOwnProperty.call(HOST_MODULES, request)) {
    try { return _load.call(this, request, parent, isMain); }   // prefer a real install
    catch (_) { return HOST_MODULES[request]; }                 // else the host stub
  }
  return _load.call(this, request, parent, isMain);
};

module.exports = Bun;
module.exports.__bunFFI = BUN_BUILTINS['bun:ffi'];
// Straight from PROVIDES (the declaration at the top of this file), NOT
// Object.keys() of the tables: clode's dep-closure gate reads that same literal
// out of this file's TEXT — it has no interpreter to spare (see PROVIDES). Both
// consumers therefore read one list, so what a running shim reports and what the
// gate believes cannot disagree. test/dep-closure.test.cjs keeps the list
// honest against the tables it names.
module.exports.__hostModules = PROVIDES.hostModules;        // external npm modules we stub
module.exports.__bunBuiltins = PROVIDES.bunBuiltins;        // bun: modules we resolve
module.exports.rewriteSnapshot = rewriteSnapshot;
module.exports.collectShadows = collectShadows;
module.exports._wsArgs = _wsArgs;
module.exports.warnAppletSkew = warnAppletSkew;
module.exports.CLODE_SHADOWS = CLODE_SHADOWS;
globalThis.Bun = globalThis.Bun || module.exports;   // ensure global even if required directly

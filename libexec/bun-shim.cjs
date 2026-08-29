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

// --- "the skew probe has run" signal -----------------------------------------
// extract-claude-js's diagnostics splice awaits globalThis.__clodeEnsureSnapshot
// so the applet-skew findings exist before a warnings surface reads them. That
// await is NOT enough by itself, and measuring it is the only way anyone would
// know: upstream's shell-provider builder KICKS OFF snapshot generation and
// returns the provider descriptor without awaiting it (the snapshot promise is a
// closed-over local — same shape on 2.1.241's builder and 2.1.245's). Measured on
// a real quaude built from 2.1.245: the splice's `await bridge()` resolved 7ms in
// with ZERO findings, and the probe's stderr warning landed afterwards. The unit
// test did not catch it because its stand-in bridge recorded findings
// synchronously — a fixture that could not fail.
//
// The probe, unlike the generation, is entirely ours: _rewriteSnapshotArg below
// runs synchronously the instant the snapshot command reaches child_process, and
// warnAppletSkew inside it is spawnSync. So the shim can say precisely when the
// findings are final, and the splice can wait for THAT instead of for a promise
// that never covered it.
let _snapshotProbed = false;
const _snapshotProbeWaiters = [];
function _markSnapshotProbed() {
  if (_snapshotProbed) return;
  _snapshotProbed = true;
  while (_snapshotProbeWaiters.length) { try { _snapshotProbeWaiters.shift()(); } catch (_) {} }
}
// Resolve true once a snapshot command has been intercepted (findings final), or
// false after `ms`. BOUNDED on purpose, and the bound is the whole design: a
// session that never generates a snapshot — skipSnapshot, an unsupported shell, a
// generation that throws — must degrade to today's lazy behaviour, not hang the
// surface that called us. The caller (the splice) only reaches this after the
// bridge itself resolved, so the normal case is a handful of async hops, not a
// wait; the deadline exists solely so the abnormal case is finite.
const _SKEW_PROBE_WAIT_MS = 2000;
function awaitSkewProbe(ms) {
  if (_snapshotProbed) return Promise.resolve(true);
  const wait = typeof ms === 'number' && ms >= 0 ? ms : _SKEW_PROBE_WAIT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
    _snapshotProbeWaiters.push(() => { clearTimeout(timer); resolve(true); });
  });
}

const _rewriteSnapshotArg = (s) => {
  if (!_looksLikeSnapshotCmd(s)) return s;
  let rewritten;
  try {
    rewritten = rewriteSnapshot(s);
  } catch (e) {
    process.stderr.write(`clode: snapshot shadow rewrite skipped: ${e && e.message}\n`);
    // Still a snapshot, still no more findings coming from it: release the waiters
    // rather than make them serve out the deadline for nothing.
    _markSnapshotProbed();
    return s;
  }
  // Rewrite succeeded: probe the host applets for flag skew (best-effort, never
  // fatal). When the probe finds skew, rebuild with the findings so the affected
  // shadows carry the self-explaining failure trailer (see buildShadow).
  try {
    const findings = warnAppletSkew(collectShadows(s));
    if (findings && findings.length) rewritten = rewriteSnapshot(s, findings);
  } catch (_) {}
  _markSnapshotProbed();
  return rewritten;
};
// Rewrite any snapshot-generator command found in a child_process invocation.
// execFile/spawn family: the command string is an element of the args ARRAY (2nd arg).
// exec/execSync family: the command is the FIRST string arg.
const _rewriteArgsArray = (a) => Array.isArray(a) ? a.map(_rewriteSnapshotArg) : a;

// Unpatched spawnSync for warnAppletSkew's own applet probes, so they never
// recurse back through the snapshot-rewrite wrapper installed just below.
const _rawSpawnSync = cp.spawnSync;

// rg lands here as the FILE, not inside the args array, so the snapshot rewrite
// above never saw it. Bun.spawn HAS routed rg->ugrep since the routing spec, but
// the bundle reaches ripgrep both ways — and the startup calls go through node's
// child_process. The result was one binary with two spawn routes disagreeing about
// the same command: `Bun.spawn(['rg',...])` translated, `spawn('rg',[...])` did not
// and simply failed ENOENT. Route both through the same function.
//
// Applies to quaude AND naude, which is the point: bun-shim is baked into both,
// whereas node-shim is quaude-only. Wiring this into node-shim would have made
// quaude translate while naude did not — inventing the divergence this project
// exists to remove.
const _rewriteRgFileArgs = (file, args) => {
  if (file !== 'rg' || !Array.isArray(args)) return null;
  const rewritten = _rewriteRgSpawn([file, ...args]);
  // Untranslatable (e.g. --files) or no ugrep: _rewriteRgSpawn returns the argv
  // unchanged, and we leave the call alone so the app's own not-found fallback
  // still engages, exactly as before.
  if (!Array.isArray(rewritten) || rewritten[0] === file) return null;
  return { file: rewritten[0], args: rewritten.slice(1) };
};

for (const m of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const orig = cp[m];
  if (typeof orig !== 'function') continue;
  cp[m] = function (file, args, ...rest) {
    const rg = _rewriteRgFileArgs(file, args);
    if (rg) return orig.call(this, rg.file, _rewriteArgsArray(rg.args), ...rest);
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
  rg:   { applet: 'rg',    env: 'CLODE_UGREP', translate: true,
          fix: 'set CLODE_UGREP to a compatible ugrep, or upgrade it',
          probe: (f) => ({ args: ['--version'],                  skew: (c) => c >= 2 }),
          skewRcTest: '[ "$_rc" -ge 2 ]' },
};

// rg → ugrep argv translation. Spec: docs/superpowers/specs/2026-07-24-rg-to-ugrep-routing-design.md
// Faithful for the common set; throws on rg-only flags rather than mis-search.
class RgTranslateError extends Error {
  constructor(flag) {
    super(`clode: rg→ugrep shim doesn't translate ${flag} (rg-only); use ugrep directly`);
    this.name = 'RgTranslateError'; this.flag = flag; this.code = 'CLODE_RG_UNTRANSLATABLE';
  }
}
// rg-only, no faithful ugrep spelling.
const _RG_DENY_LONG = new Set(['--json', '--files', '--vimgrep', '--stats', '--type']);
// short flags that consume the next argv as their value (pass verbatim, kept adjacent).
const _RG_VALUE_SHORT = new Set(['A', 'B', 'C', 'm', 'e', 'f']);
function _pushGlob(tail, g) {
  if (g == null) throw new RgTranslateError('--glob (missing value)');
  tail.push(g[0] === '!' ? '--exclude=' + g.slice(1) : '--include=' + g);
}
function rgToUgrep(argv) {
  const tail = [], pos = [];
  let injectIgnore = true, endOpts = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (endOpts || a === '-' || a[0] !== '-') { pos.push(a); continue; }
    if (a === '--') { endOpts = true; pos.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      if (name === '--no-ignore') { injectIgnore = false; continue; }
      if (name === '--smart-case') { tail.push('-j'); continue; }
      if (name === '--hidden') { tail.push('-.'); continue; }
      if (name === '--glob') { _pushGlob(tail, inline != null ? inline : argv[++i]); continue; }
      if (_RG_DENY_LONG.has(name)) throw new RgTranslateError(name);
      tail.push(a); continue; // pass verbatim
    }
    const ch = a[1];
    if (a === '-S') { tail.push('-j'); continue; }
    if (ch === 't') throw new RgTranslateError('-t');
    if (ch === 'g') { _pushGlob(tail, a.length > 2 ? a.slice(2) : argv[++i]); continue; }
    if (_RG_VALUE_SHORT.has(ch) && a.length === 2) { tail.push(a, argv[++i]); continue; }
    tail.push(a); continue; // pass verbatim (-i, -n, -A3, …)
  }
  const pre = ['-r'];
  if (injectIgnore) pre.push('--ignore-files');
  pre.push('-I');
  return [...pre, ...tail, ...pos];
}

// Shell twin of rgToUgrep — the body of the injected/rewritten `function rg`.
// Uses bash/zsh arrays (the snapshot is sourced by bash/zsh, never dash). Must
// stay byte-identical in output to rgToUgrep; test/rg-to-ugrep.test.cjs locks it.
function rgShadowBody() {
  return [
    'function rg {',
    '  local _bin="${CLODE_UGREP:-$(command -v ugrep 2>/dev/null)}"',
    `  [ -n "$_bin" ] || { echo "clode: rg needs 'ugrep' (set CLODE_UGREP or install it)" >&2; return 127; }`,
    '  local -a _tail _pos; local _ignore=1 _end=0 _a _g',
    '  while [ $# -gt 0 ]; do',
    '    _a=$1',
    '    if [ $_end -eq 1 ]; then _pos+=("$_a"); shift; continue; fi',
    '    case "$_a" in',
    '      --) _end=1; _pos+=("$_a") ;;',
    '      --no-ignore) _ignore=0 ;;',
    '      --smart-case) _tail+=(-j) ;;',
    '      --hidden) _tail+=(-.) ;;',
    '      --glob=*) _g=${_a#--glob=}; case "$_g" in "!"*) _tail+=("--exclude=${_g#!}");; *) _tail+=("--include=$_g");; esac ;;',
    '      --glob) shift; _g=$1; case "$_g" in "!"*) _tail+=("--exclude=${_g#!}");; *) _tail+=("--include=$_g");; esac ;;',
    `      --json|--files|--vimgrep|--stats|--type|--type=*) echo "clode: rg→ugrep shim doesn't translate \${_a%%=*} (rg-only); use ugrep directly" >&2; return 2 ;;`,
    '      -S) _tail+=(-j) ;;',
    `      -t|-t*) echo "clode: rg→ugrep shim doesn't translate -t (rg-only); use ugrep directly" >&2; return 2 ;;`,
    '      -g) shift; _g=$1; case "$_g" in "!"*) _tail+=("--exclude=${_g#!}");; *) _tail+=("--include=$_g");; esac ;;',
    '      -g*) _g=${_a#-g}; case "$_g" in "!"*) _tail+=("--exclude=${_g#!}");; *) _tail+=("--include=$_g");; esac ;;',
    '      -A|-B|-C|-m|-e|-f) _tail+=("$_a" "$2"); shift ;;',
    '      -) _pos+=("$_a") ;;',
    '      -*) _tail+=("$_a") ;;',
    '      *) _pos+=("$_a") ;;',
    '    esac',
    '    shift',
    '  done',
    '  local -a _pre=(-r); [ $_ignore -eq 1 ] && _pre+=(--ignore-files); _pre+=(-I)',
    '  exec "$_bin" "${_pre[@]}" "${_tail[@]}" "${_pos[@]}"',
    '}',
  ].join('\n');
}

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
  if (known.translate) return rgShadowBody(); // rg → full ugrep-translating body; upstream flags dropped
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
  let out = '', i = 0, sawAny = false, sawRg = false, lastEnd = -1;
  _eachShadow(text, ({ name, parsed, mIndex, endIdx }) => {
    // Body looks like an upstream multiplexer shadow.
    const known = CLODE_SHADOWS[name];
    if (!known || known.applet !== parsed.applet){
      throw new Error(`clode: unrecognized search shadow function ${name} -> ${parsed.applet}; ` +
        `update CLODE_SHADOWS in bun-shim.cjs`);
    }
    out += text.slice(i, mIndex) + buildShadow(name, known, parsed, byName.get(name));
    i = endIdx; lastEnd = out.length; sawAny = true;
    if (name === 'rg') sawRg = true;
  });
  out += text.slice(i);
  // Additive: a real snapshot that shadows find/grep but not rg gets an injected
  // ugrep-translating rg shadow, spliced right after the last rewritten shadow.
  if (sawAny && !sawRg) out = out.slice(0, lastEnd) + '\n' + rgShadowBody() + out.slice(lastEnd);
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

const _rgSurfaced = new Set();
// Loud, at the point of use: ugrep rejected an rg→ugrep translation at runtime.
// exit >=2 only (1 == no match). Records to /doctor so the app's fallback can't hide it.
function _surfaceRgSkew(rewritten, status){
  if (!(status >= 2)) return;
  const key = rewritten.join('\0');
  if (_rgSurfaced.has(key)) return;
  _rgSurfaced.add(key);
  const why = `host ugrep exited ${status} for a translated rg command: ${rewritten.join(' ')}`;
  process.stderr.write(`clode: rg→ugrep translation was rejected by ugrep — ${why}\n` +
    `       file an issue with this command; meanwhile run ugrep directly.\n`);
  _recordSkew({ name: 'rg', applet: 'ugrep', why, fix: 'refine the rg→ugrep translation (rgToUgrep)' });
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

// The applet we translate to is missing. Do NOT fall through to whatever `rg` the
// host happens to have.
//
// Falling through looks helpful and is not: it makes quaude's behaviour depend on
// what is installed, so the same binary searches with ugrep on one machine and
// ripgrep on another, with different ignore rules and different output — a
// difference nothing measures and no one asked for. It also contradicts the
// reason we translate at all: ugrep and bfs are portable to every target quaude
// supports and rg is not, so rg is precisely the thing we cannot build on.
//
// The shell path already decided this. The rg shadow refuses with 127 and
// "clode: rg needs 'ugrep'" rather than calling a host rg; this makes the spawn
// path agree, which is the same two-routes-disagreeing bug fixed in e356a20,
// one level up.
//
// Returning an argv that cannot resolve keeps the app's own not-found fallback
// working exactly as it does when rg is genuinely absent — deterministically,
// whether or not this host has rg.
function _rgAppletMissing(cmd, applet) {
  process.stderr.write(
    `clode: rg needs '${applet}' (set CLODE_${applet.toUpperCase()} or install it); `
    + 'not falling back to a host rg — quaude translates rg to portable applets on purpose\n');
  _rgDebug(cmd, `!! needs ${applet}`);
  return ['clode-rg-unavailable', ...cmd.slice(1)];
}

// ONE parseable line per rg call the shim sees, whatever the outcome:
//
//   clode rg-debug: <rg argv> => <applet argv>        translated
//   clode rg-debug: <rg argv> !! needs <applet>       this host has no ugrep/bfs
//   clode rg-debug: <rg argv> !! untranslatable <flag>  rg-only flag, we refuse
//
// The verdict used to be printed ONLY on the success path, which made the
// observer (scripts/rg-inventory.mjs) blind on exactly the hosts where
// something was wrong: no ugrep/bfs meant zero lines matched, so the gate saw
// zero calls and blamed upstream for "changing its rg usage" when in truth it
// had observed nothing at all. Every CI runner is such a host. Which rg calls
// upstream MAKES and whether THIS host can translate them are two different
// questions; emitting the argv on all three paths is what lets the gate answer
// them separately instead of conflating them.
function _rgDebug(cmd, verdict) {
  if (!process.env.CLODE_RG_DEBUG) return;
  process.stderr.write(`clode rg-debug: ${cmd.join(' ')} ${verdict}\n`);
}

// `rg --files` is a file LISTING, not a search, so it does not translate to a
// grep at all. It is handled here rather than in rgToUgrep (which yields ugrep
// argv by construction) because the right tool depends on the flags.
//
// INTENTIONAL DIVERGENCE (user, 2026-08-21): we do not look for ripgrep and we do
// not want it. rg is Rust and cannot exist everywhere quaude does — NetBSD/sparc,
// Tiger PPC, Haiku. ugrep and bfs are as portable as quaude is, so we rely on
// them ON PURPOSE. Diverging from Claude here is the design, not a shortfall, and
// "install rg" is not the remedy.
//
// Neither tool alone is faithful, but each is EXACT in one regime — measured:
//                     .gitignore   hidden      empty files   binary
//   ugrep -l ''       honors       skips       DROPS         needs no -I
//   bfs -type f       no support   lists all   keeps         keeps
// So dispatch on whether ignore semantics are wanted:
//   --no-ignore  -> bfs, which HAS no ignore logic; that is precisely the ask, and
//                   it keeps empty files (a marker file like .orphaned_at is
//                   usually empty, and ugrep's -l would silently miss it).
//   otherwise    -> ugrep --ignore-files, the only one of the two that reads
//                   .gitignore. Known divergence: zero-length files are omitted,
//                   because -l lists files with a MATCH and an empty file has no
//                   lines to match.
function rgFilesToListing(args) {
  let hidden = false, noIgnore = false, maxDepth = null;
  const globs = [], paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--files') continue;
    else if (a === '--hidden' || a === '.') hidden = true;
    else if (a === '--no-ignore') noIgnore = true;
    else if (a === '--max-depth' || a === '--maxdepth') maxDepth = args[++i];
    else if (a.startsWith('--max-depth=')) maxDepth = a.slice(12);
    else if (a === '--glob' || a === '-g') globs.push(args[++i]);
    else if (a.startsWith('--glob=')) globs.push(a.slice(7));
    else if (a.startsWith('-')) throw new RgTranslateError(a);
    else paths.push(a);
  }
  if (!paths.length) paths.push('.');

  if (noIgnore) {
    const bfs = process.env.CLODE_BFS || which('bfs');
    if (!bfs) return null;
    const out = [bfs, ...paths];
    if (maxDepth) out.push('-maxdepth', String(maxDepth));
    out.push('-type', 'f');
    // rg skips dotfiles unless --hidden; bfs lists everything, so exclude them.
    if (!hidden) out.push('!', '-path', '*/.*');
    if (globs.length === 1) out.push(globs[0].includes('/') ? '-path' : '-name', globs[0]);
    else if (globs.length > 1) {
      out.push('(');
      globs.forEach((g, i) => {
        if (i) out.push('-o');
        out.push(g.includes('/') ? '-path' : '-name', g);
      });
      out.push(')');
    }
    return out;
  }

  const ugrep = process.env.CLODE_UGREP || which('ugrep');
  if (!ugrep) return null;
  // -L (files WITHOUT a match) plus a pattern that cannot match lists every file
  // ugrep would have searched — including ZERO-LENGTH ones, which `-l ''` drops
  // because -l needs a matching line and an empty file has none. That mattered:
  // marker files (.orphaned_at) are empty, and silently omitting them is the kind
  // of wrong answer nothing downstream can detect.
  //
  // `$^` demands end-of-line immediately followed by start-of-line, which no
  // position satisfies. That it never matches is ENGINE BEHAVIOUR, not a law, and
  // if some ugrep build ever did match it this would list NOTHING — a silent empty
  // result, worse than the bug it replaces. So it is pinned by a fixture test
  // (rg --files: ugrep branch lists empty/ignored/hidden exactly) that fails on a
  // ugrep whose semantics differ, rather than trusted.
  const out = [ugrep, '-r', '-L', '--ignore-files'];
  if (hidden) out.push('--hidden');
  if (maxDepth) out.push(`--depth=${maxDepth}`);
  for (const g of globs) out.push(`--include=${g}`);
  out.push('$^', ...paths);
  return out;
}

// If cmd[0] is bare `rg`, rewrite to ugrep with translated argv (spec: rg-to-ugrep).
// ugrep-absent → cmd untouched, so the app's not-found fallback path is preserved.
function _rewriteRgSpawn(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0) return cmd;
  const exe = cmd[0];
  if (exe !== 'rg') return cmd;
  // --files is a listing, not a search: different tool, handled before rgToUgrep.
  if (cmd.includes('--files')) {
    try {
      const listing = rgFilesToListing(cmd.slice(1));
      if (!listing) return _rgAppletMissing(cmd, cmd.includes('--no-ignore') ? 'bfs' : 'ugrep');
      _rgDebug(cmd, `=> ${listing.join(' ')}`);
      return listing;
    } catch (e) {
      if (e instanceof RgTranslateError) {
        process.stderr.write(e.message + '\n');
        _rgDebug(cmd, `!! untranslatable ${e.flag}`);
      }
      return cmd;
    }
  }
  const ugrep = process.env.CLODE_UGREP || which('ugrep');
  if (!ugrep) return _rgAppletMissing(cmd, 'ugrep');
  try {
    const rewritten = [ugrep, ...rgToUgrep(cmd.slice(1))];
    _rgDebug(cmd, `=> ${rewritten.join(' ')}`);
    return rewritten;
  } catch (e) {
    if (e instanceof RgTranslateError) {
      process.stderr.write(e.message + '\n');
      _rgDebug(cmd, `!! untranslatable ${e.flag}`);
    }
    return cmd;
  }
}

// --- spawn: approximate Bun.spawn -> Node child_process ---
function spawn(cmdOrOpts, maybeOpts){
  let cmd, opts;
  if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts||{}; }
  else { opts = cmdOrOpts||{}; cmd = opts.cmd; }
  const _origCmd = cmd;
  cmd = _rewriteRgSpawn(cmd);
  const exe = cmd[0];
  const env = opts.env || process.env;
  // Bun resolves the executable synchronously and THROWS if it isn't found, so
  // the cli's try/catch fallbacks engage. Node's cp.spawn instead emits an async
  // 'error' and never 'exit' — which makes `await proc.exited` hang FOREVER and
  // (with no 'error' listener) crashes the process. This froze the interactive
  // TUI when it spawned `rg` (ripgrep, bundled in the native binary) and rg was
  // absent from the host PATH. Match Bun: throw synchronously on a missing exe.
  // The same two win32 blind spots as which(), one level up: `C:\tools\ugrep.exe`
  // has no '/', so it used to be treated as a bare command name and hunted for
  // inside every PATH entry (never found -> a spurious throw), and an extension-less
  // pathed name was X_OK'd, which on Windows answers nothing useful. So: pathedness
  // is decided the way node decides it, and a pathed win32 name is accepted if the
  // name or any PATHEXT spelling of it is a file — the set libuv would go on to try.
  if (exe && !_exeIsPathed(exe, process.platform === 'win32')) {
    if (!which(exe, { PATH: env.PATH, PATHEXT: env.PATHEXT })) throw new Error(`Executable not found in $PATH: "${exe}"`);
  } else if (exe) {
    if (process.platform === 'win32') {
      if (!_whichLeaves(exe, true, env.PATHEXT).some(_isFileWin)) throw new Error(`Executable not found: "${exe}"`);
    } else {
      try { fs.accessSync(exe, fs.constants.X_OK); }
      catch (_) { throw new Error(`Executable not found: "${exe}"`); }
    }
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
    let done = false; const fin = (c)=>{ if(!done){ done=true;
      if (cmd !== _origCmd && _origCmd[0] === 'rg') _surfaceRgSkew(cmd, c);
      res(c); } };
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
  const cmd0 = Array.isArray(cmdOrOpts)?cmdOrOpts:(cmdOrOpts.cmd);
  const cmd = _rewriteRgSpawn(cmd0);
  const r = cp.spawnSync(cmd[0], cmd.slice(1), {encoding:'buffer'});
  if (cmd !== cmd0 && cmd0[0] === 'rg') _surfaceRgSkew(cmd, r.status);
  return { exitCode: r.status??0, stdout: r.stdout||Buffer.alloc(0), stderr: r.stderr||Buffer.alloc(0), success: (r.status===0) };
};

// Fallback only. On a real Windows PATHEXT is always set; this is the documented
// default's load-bearing head, and the same four clode-hosttools.findTool and
// clode-resolve.whichClaude fall back to — three lookups, one list.
const WHICH_PATHEXT_DEFAULT = '.COM;.EXE;.BAT;.CMD';

// "Is this an executable file?", per platform.
//
// POSIX: X_OK, byte-for-byte the original predicate (a +x DIRECTORY still
// answers yes, as it always has — narrowing that is a behaviour change and this
// is not the commit for it).
//
// win32: a regular file, and deliberately NOT X_OK. There is no execute bit to
// ask about, and asking is worse than useless here: quaude's fs.accessSync is
// __tjs_fs_sync.access -> the CRT's _access (spike/quickjs/patches/txiki-sync-fs
// .patch, `FSS_PATH_INT(access, access(p, m))`), which validates its mode as
// `(mode & ~6) == 0` and so rejects X_OK (1) with EINVAL for EVERY path,
// existing or not. Under Node/libuv the same call is a no-op that succeeds
// (fs__access only consults FILE_ATTRIBUTE_READONLY for W_OK) — which is why the
// sibling lookups get away with it and this one, running on the tjs engine,
// would not. UNVERIFIED ON WINDOWS: the _access claim is read from UCRT's
// documented validation, not measured. Nothing here depends on which way it
// falls — a stat is the honest question either way.
function _isExecPosix(p){
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch(_){ return false; }
}
function _isFileWin(p){
  try { return fs.statSync(p).isFile(); } catch(_){ return false; }
}

// The leaf names to look for in each PATH directory.
//
// POSIX: exactly the name, no probing — unchanged.
//
// win32: the name AS GIVEN first, then name+ext for each PATHEXT entry. Entries
// are lower-cased, which is what makes PATHEXT case-insensitive: NTFS is, so
// `.EXE` and `.exe` both find ugrep.exe, and lower-casing keeps the string we
// return predictable. Malformed entries without a leading dot are ignored rather
// than concatenated into `ugrepexe`.
//
// A name that ALREADY ends in a PATHEXT extension is taken at its word and gets
// no appendices: `ugrep.exe` must not go looking for `ugrep.exe.com`. But a name
// whose trailing dot-something is not an executable extension (`python3.11`,
// `node20.1`) is still probed with the extensions — that is a real spelling and
// dropping it is how you lose a tool that is right there.
function _whichLeaves(bin, isWin, pathext){
  if (!isWin) return [bin];
  const raw = (pathext === undefined || pathext === null)
    ? (process.env.PATHEXT || WHICH_PATHEXT_DEFAULT) : pathext;
  const exts = [];
  for (const entry of String(raw).split(';')){
    const ext = entry.trim().toLowerCase();
    if (ext && ext[0] === '.' && !exts.includes(ext)) exts.push(ext);
  }
  const low = String(bin).toLowerCase();
  const leaves = [bin];
  if (exts.some((e) => low.endsWith(e))) return leaves;
  for (const ext of exts) leaves.push(bin + ext);
  return leaves;
}

// Does this name already carry a path, so PATH must not be searched? Node's own
// rule (node-shim child_process.cjs resolveExe): a slash anywhere, and on win32
// also a backslash or a drive letter. Without the win32 half, `C:\tools\ugrep.exe`
// looks like a bare command name and gets hunted for inside every PATH directory.
function _exeIsPathed(exe, isWin){
  const s = String(exe);
  return s.includes('/') || (!!isWin && (s.includes('\\') || /^[a-zA-Z]:/.test(s)));
}

// Bun.which: first executable named `bin` on PATH, or null.
//
// WINDOWS. An executable on PATH is `ugrep.exe`, never `ugrep`, so the bare-name
// walk this used to do matched NOTHING — and the callers read that as "the applet
// is not installed": every rg-derived file search on a Windows quaude took the
// `clode-rg-unavailable` path (see _rgAppletMissing) even with ugrep sitting right
// there on PATH, unless the user had set CLODE_UGREP to a path spelled out to the
// extension. So, win32-only: probe PATHEXT, strip the quotes cmd.exe tolerates
// around a PATH element (libuv's search_path does the same — deps/libuv/src/win/
// process.c), and split on ';' (path.win32.delimiter, not the host's).
//
// The returned path KEEPS the extension, because the eventual spawn needs it:
// libuv's path_search_walk_ext tries the exact name only when it HAS one, then
// appends .com and .exe — so `...\ugrep` still finds ugrep.exe but nothing finds
// a ugrep.cmd. (Corollary, unchanged by this fix: a .BAT/.CMD hit is a path
// CreateProcess cannot launch without a shell. Reporting where it is remains
// more honest than reporting nothing.)
//
// An empty PATH element is skipped on win32: Windows would search the current
// directory there, and CWD-on-PATH is a footgun we decline to reproduce. On POSIX
// an empty element keeps resolving relative to cwd exactly as it did.
//
// isWin/isExec/PATHEXT are injectable seams, not options the bundle passes: they
// are how the win32 behaviour is tested from a Mac (test/bun-shim-which.test.cjs),
// the same shape clode-hosttools.findTool uses.
function which(bin, opts){
  const o = opts || {};
  const isWin = (o.isWin === undefined) ? (process.platform === 'win32') : !!o.isWin;
  const PATH = o.PATH || process.env.PATH || '';
  const P = isWin ? path.win32 : path.posix;
  const isExec = o.isExec || (isWin ? _isFileWin : _isExecPosix);
  const leaves = _whichLeaves(bin, isWin, o.PATHEXT);
  for (let dir of PATH.split(P.delimiter)){
    if (isWin){
      // Same unquoting libuv's search_path does when it walks this very PATH
      // (deps/libuv/src/win/process.c, "Adjust if the path is quoted") — BOTH
      // quote characters, so what we report and what the spawn then finds cannot
      // disagree over `"C:\Program Files\ugrep"`.
      if (dir.length > 1 && (dir[0] === '"' || dir[0] === "'") && dir[dir.length-1] === dir[0]) {
        dir = dir.slice(1, -1);
      }
      if (!dir) continue;   // never the CWD (libuv likewise skips a zero-length slice)
    }
    for (const leaf of leaves){
      const p = P.join(dir, leaf);
      if (isExec(p)) return p;
    }
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
  // The bundle calls this as generateHeapSnapshot("v8","arraybuffer") and hands the
  // result STRAIGHT to writeFileSync, so it must be bytes. v8.getHeapSnapshot() is a
  // Readable, which made /heapdump fail on node with "The \"data\" argument must be of
  // type string or an instance of Buffer... Received an instance of HeapSnapshotStream".
  // v8.writeHeapSnapshot() is the synchronous route; read it back and hand over the
  // buffer. Under quaude this still throws (quickjs has no V8 heap accounting) -- but
  // now by NAME, from the v8 wall, instead of a nameless TypeError.
  generateHeapSnapshot: (_fmt, shape)=> {
    const os = require('os'), fsx = require('fs'), pathx = require('path');
    const f = pathx.join(os.tmpdir(), `clode-heap-${process.pid}-${Date.now()}.heapsnapshot`);
    try {
      v8.writeHeapSnapshot(f);
      const buf = fsx.readFileSync(f);
      if (shape === 'arraybuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return buf;
    } finally {
      try { fsx.unlinkSync(f); } catch(_) {}
    }
  },

  // assets embedded in __BUN — none when running as loose JS. Returning [] makes the
  // app take its on-disk path. TODO: if a feature needs an embedded asset, supply it.
  embeddedFiles: [],

  // Upstream guards its "claude gateway" (enterprise auth/telemetry) path with
  // `typeof Bun > "u"` immediately before `new Bun.SQL(...)`, throwing its own
  // friendly "claude gateway requires the native binary" when that's true — as
  // it is under real Node (`"undefined" > "u"`). Under quaude/naude it's FALSE,
  // because THIS shim defines a Bun global at all, so the guard silently passes
  // and control falls through to `new Bun.SQL(...)`, which we never implemented
  // -> the user saw a bare "Bun.SQL is not a constructor" instead. We keep the
  // Bun global (removing it breaks far more than this one path) and hand back
  // upstream's own message instead. Reachable only via the separate `claude
  // gateway --config <path>` subcommand (commander-registered), not the -p or
  // interactive routes; see test/bun-shim-sql-guard.test.cjs.
  // Contrast Bun.WebView below (and elsewhere), which is correctly ABSENT so
  // upstream's `"WebView" in Bun` feature-detect reads false and that branch is
  // skipped cleanly -- adding SQL here must not (and does not) disturb that
  // pattern for WebView or any other `in`/`typeof` feature-detect.
  // Bun.build — NEW IN 2.1.247, and it bundles a PLUGIN'S HOOKS MODULE:
  //   Bun.build({ entrypoints: [join(repoRoot, r, ...)], target: 'bun', format: 'esm',
  //               minify: false, external: [TYPES_MODULE] })
  // wrapped in a try/catch that becomes `HooksError: cannot bundle the hooks module of
  // <plugin>`. So upstream already has a product-level failure path for this, and a
  // throwing stub lands there with a message that names the real reason.
  //
  // NOT IMPLEMENTED, deliberately: this is a JavaScript bundler. quaude ships no
  // esbuild and no Node, so there is nothing to delegate to on a target, and writing
  // one is wildly out of proportion to the feature it serves. It belongs to the same
  // capability as vm.SourceTextModule — plugins that run JavaScript — which is tracked
  // in BACKLOG as the next cycle's first item. Whoever builds that will need this too.
  build: function build() {
    throw new Error('Bun.build is not available in this build of Claude Code: '
      + 'bundling a plugin hooks module needs a JavaScript bundler, which quaude does '
      + 'not ship. Plugins that do not register JS tools are unaffected.');
  },
  SQL: function SQL() {
    throw new Error('claude gateway requires the native binary');
  },

  // Bun.isStandaloneExecutable: whether running as a Bun `--compile` binary.
  // quaude (tjs) / naude (Node SEA) are NOT Bun standalone executables, so false
  // is the CORRECT answer. Explicit (not a stub) so the value is honest and the
  // bundle's `Bun.isStandaloneExecutable===true` feature-detect resolves cleanly.
  isStandaloneExecutable: false,

  // --- heavy / not-yet-done ---
  Terminal: TODO('Terminal'),        // PTY for the TUI — likely needs node-pty
  Transpiler: Object.assign(
    function(){ throw new Error('Bun.Transpiler not yet implemented (runtime TS) — consider esbuild/sucrase'); },
    { __bunShimStub: true }),
  listen: TODO('listen'),            // net.createServer wrapper
  serve: TODO('serve'),
  file: TODO('file'),
  write: TODO('write'),
  // connect: Bun's TCP client (the "direct_dial" MCP-over-TCP transport). Niche,
  // feature-gated (not on the core path). Stub with a CLEAR error rather than
  // leave it undefined — a raw `Bun.connect is not a function` under quickjs has
  // no symbol name and is a debugging trap. Implement (map to node:net.Socket) if
  // TCP direct-dial becomes a needed feature.
  connect: TODO('connect'),
  // TOML: Bun.TOML.parse (config parsing). Niche/feature-gated (JSON is the norm).
  // Object stub so `Bun.TOML.parse(...)` throws a clear error instead of the raw
  // "not a function". Implement via a toml dep (cf. Bun.YAML) if a TOML config
  // path is actually exercised.
  TOML: Object.assign(
    { parse(){ throw new Error('Bun.TOML.parse not yet implemented in the Node host shim'); } },
    { __bunShimStub: true }),
  // Bun.ant — DELIBERATELY ABSENT, and it must STAY absent. New in 2.1.243,
  // Anthropic's own private Bun namespace; four methods, all needing a syscall:
  //
  //   getPeerUid(fd) / getPeerPid(fd)  SO_PEERCRED / LOCAL_PEERCRED on a UDS
  //   setDumpable(bool)                Linux prctl(PR_SET_DUMPABLE, 0)
  //   memoryPressureLevel()            macOS memory-pressure level
  //
  // DO NOT STUB IT. Upstream gates a whole capability on
  // `typeof Bun.ant?.getPeerPid === "function"`, so a stub — even a throwing
  // one — flips that probe TRUE and makes upstream advertise a peer-credential
  // capability we cannot honor. That is the Bun.SQL trap above running in
  // reverse: there, defining a Bun global defeated a guard that wanted Bun
  // absent; here, defining Bun.ant would defeat a probe that is currently
  // getting the RIGHT answer. Absent is the faithful answer, the same shape
  // that makes Bun.WebView benign.
  //
  // WHY NOT IMPLEMENT IT (checked, not assumed):
  //   - Peer credentials are technically within reach: the vendored txiki.js
  //     exposes `socket_from_fd(fd)` and `sock.getopt(level, opt, len)` in
  //     mod_posix-socket.c. But nothing can ever call them here, because BOTH
  //     call sites sit behind declared node-shim walls that throw first —
  //     `net.connect` (libexec/node-shim/modules/net.cjs `connectUnimpl`) for
  //     the UDS client, and the missing `net.Server` for the daemon that would
  //     accept the connection. Implementing peer creds means implementing
  //     behind a closed door. test/bun-shim-ant-gap.test.cjs pins that
  //     reasoning: it goes RED the day either wall comes down, which is
  //     exactly when this decision needs re-taking.
  //   - setDumpable: txiki.js has no prctl binding at all (grepped: zero hits).
  //   - memoryPressureLevel: no macOS memory-pressure primitive either.
  //
  // WHAT A USER OBSERVES, per call site, all four with upstream's own fallback:
  //   - capability probe -> false, so upstream drops that capability from its
  //     advertised list. Clean feature detection; nothing is broken.
  //   - daemon peer-uid check (`aXn`) -> catch, warn, returns null, which
  //     upstream reads as "no objection", i.e. FAIL-OPEN. Harmless only because
  //     no daemon can listen under the shim; it is the first thing to fix if
  //     net.Server ever lands.
  //   - UDS client peer-pid check -> catch, warn, then upstream REFUSES to send
  //     ("endpoint-unverifiable"). This one is a hard refusal, not a
  //     degradation — again unreachable only because net.connect throws first.
  //   - macOS background low-memory probe -> catch, warn, level undefined, so
  //     `lowMem` reads false and background sessions never retire early for
  //     memory pressure. Non-macOS uses os.freemem() and is unaffected.
  //   - Linux setDumpable -> reports "prctl unavailable"; the process stays
  //     dumpable, i.e. one hardening step short of upstream.
  //
  // Recorded as an intentional divergence in test/shim-surface/golden.json.
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
    suffix: process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so',
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
// Give the engine's native WHATWG WebSocket the surface npm `ws` has, because the
// bundle consumes it BOTH ways and we hand out the same object for both.
//
// Measured against the 2.1.238 bundle:
//   - one consumer is WHATWG: `new WebSocket(url,{headers})` + addEventListener
//     ("open"/"message"/"error"/"close"). The native WS already serves this.
//   - the other is ws-shaped: it wraps an instance and calls removeAllListeners(),
//     send(), readyState, and `readyState === OPEN ? close(code,reason)
//     : terminate()`. The native WS has NONE of on/once/removeAllListeners/
//     terminate, so that path died with "not a function".
//
// And it died while we were ADVERTISING the transport: __clodeWsUnavailable is
// false under tjs whenever a native WS exists, which is the honest answer to "is
// there a transport" and the wrong answer to "does it satisfy the contract". A
// capability flag that says yes must mean the surface is there.
//
// This is the cheap half of closing the quaude-vs-naude WebSocket divergence.
// The expensive half is running npm ws itself. That was assumed to be blocked on
// http.request (an HTTP/1.1 client with 'upgrade'); http.request now EXISTS
// (libexec/node-shim/modules/http.cjs, 2026-08-22) and ws is still blocked, for
// a different reason found by reading ws: `initAsClient` unconditionally sets
// `opts.createConnection = opts.createConnection || (isSecure ? tlsConnect :
// netConnect)`, so ws never uses the client's own socket — it demands
// net.connect/tls.connect, which are still walls (and it reads
// `socket._writableState.length` for bufferedAmount besides). Unblocking ws
// means a real net.Socket, not more HTTP. Nothing on the surface the bundle
// actually uses needs it.
function _wsShape(ws) {
  if (!ws || typeof ws.addEventListener !== 'function' || typeof ws.on === 'function') return ws;
  const B = (() => { try { return require('buffer').Buffer; } catch (_) { return null; } })();
  const toBuf = (d) => {
    if (!B) return d;
    if (typeof d === 'string') return B.from(d);
    if (d instanceof ArrayBuffer) return B.from(new Uint8Array(d));
    if (ArrayBuffer.isView(d)) return B.from(d.buffer, d.byteOffset, d.byteLength);
    return d;
  };
  // ws hands its listeners unwrapped values, not Event objects. Translate per
  // event so a ws-shaped consumer sees what it does on Node.
  const adapt = (type, fn) => {
    if (type === 'message') return (e) => fn(toBuf(e && e.data), typeof (e && e.data) !== 'string');
    if (type === 'close') return (e) => fn((e && e.code) ?? 1006, toBuf((e && e.reason) || ''));
    if (type === 'error') return (e) => fn((e && (e.error || e.message)) instanceof Error
      ? e.error : new Error(String((e && (e.message || e.error)) || 'WebSocket error')));
    return () => fn();
  };
  const bound = new Map();   // fn -> [{type, wrapped}] so removeListener can detach
  const add = (type, fn, once) => {
    const wrapped = adapt(type, once ? (...a) => { remove(type, fn); fn(...a); } : fn);
    ws.addEventListener(type, wrapped);
    if (!bound.has(fn)) bound.set(fn, []);
    bound.get(fn).push({ type, wrapped });
    return ws;
  };
  const remove = (type, fn) => {
    const entries = bound.get(fn) || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type !== type) continue;
      ws.removeEventListener(type, entries[i].wrapped);
      entries.splice(i, 1);
    }
    if (!entries.length) bound.delete(fn);
    return ws;
  };
  ws.on = (type, fn) => add(type, fn, false);
  ws.addListener = ws.on;
  ws.once = (type, fn) => add(type, fn, true);
  ws.off = remove;
  ws.removeListener = remove;
  ws.removeAllListeners = (type) => {
    for (const [fn, entries] of [...bound]) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (type && entries[i].type !== type) continue;
        ws.removeEventListener(entries[i].type, entries[i].wrapped);
        entries.splice(i, 1);
      }
      if (!entries.length) bound.delete(fn);
    }
    return ws;
  };
  // ws.terminate() destroys the connection without a closing handshake. The
  // native WS exposes no such abrupt path, so this closes instead — the peer sees
  // a clean close where ws would have dropped it. Recorded as a divergence rather
  // than pretended away; it matters only to a peer distinguishing the two, and no
  // observed caller does.
  ws.terminate = () => { try { ws.close(); } catch (_) { /* already closing */ } };
  return ws;
}

function BunWebSocket(url, opts){
  const WS = _realWS();
  if (WS) { const [u, p, o] = _wsArgs(url, opts); return new WS(u, p, o); }   // npm ws (Node hosts)
  if (UNDER_TJS && typeof _nativeWS === 'function') {                          // native tjs WS (header-capable)
    return _wsShape(new _nativeWS(url, _nativeWsOptions(opts)));               // + the ws surface the bundle uses
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

// The second half of the eager-skew bridge (see _markSnapshotProbed above, and
// _skewContribution in extract-claude-js.cjs). __clodeEnsureSnapshot — patched
// into the bundle — starts snapshot generation; this says when the resulting skew
// probe has actually run, which is when __clodeDoctor.appletSkew is final.
// Guarded and bounded on the far side, so a bundle without the splice, or a run
// that never generates a snapshot, is unaffected.
globalThis.__clodeAwaitSkewProbe = awaitSkewProbe;

// A ws-shaped module for the TJS BRING-UP PATH ONLY, when the real `ws` isn't
// loadable. (CORRECTION 2026-08-22, measured: `require('ws')` under the node-shim
// loader SUCCEEDS today — this comment used to claim it "can't load at all yet".
// What fails is CONNECTING: `new WebSocket(url)` throws
// ERR_SHIM_HTTP_UNSUPPORTED_OPTION from http.request because ws always passes
// `createConnection`, i.e. it wants net.connect/tls.connect, which are still
// walls. Before the client existed the same call threw a nameless
// "not a function".) Either way the -p path merely CAPTURES ws at module-load
// time (`P(require("ws"))`) and never opens a socket — so the capture defers,
// and only CONSTRUCTING a WebSocket/Server fails loud.
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
module.exports.awaitSkewProbe = awaitSkewProbe;
module.exports._markSnapshotProbed = _markSnapshotProbed;   // for test/extract-hooks.test.cjs
module.exports.CLODE_SHADOWS = CLODE_SHADOWS;
module.exports.rgToUgrep = rgToUgrep;
module.exports.RgTranslateError = RgTranslateError;
module.exports.rgShadowBody = rgShadowBody;
module.exports._rewriteRgSpawn = _rewriteRgSpawn;
module.exports._whichLeaves = _whichLeaves;     // exported for test/bun-shim-which.test.cjs
module.exports._exeIsPathed = _exeIsPathed;     //   (the win32 seams, driven from a Mac)
module.exports.rgFilesToListing = rgFilesToListing;
globalThis.Bun = globalThis.Bun || module.exports;   // ensure global even if required directly

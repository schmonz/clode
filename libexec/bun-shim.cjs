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
// blobulated native builder process.execPath IS the blobulated clode binary. So the gate
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
// How an upstream shadow invokes its applet under an argv0: zsh's `ARGV0=<applet> cmd`,
// bash's `exec -a <applet> cmd`. Stated ONCE; the snapshot detector below, SHADOW_APPLET
// and _SHADOW_CALL are all built from it.
const _SHADOW_INVOKE = '(?:ARGV0=|exec -a )';
const _SNAPSHOT_SHADOW = new RegExp(_SHADOW_INVOKE);
const _looksLikeSnapshotCmd = (s) =>
  typeof s === 'string' && s.indexOf('SNAPSHOT_FILE=') !== -1 && (_SNAPSHOT_SHADOW.test(s) || _rgOwnAliasAt(s) !== null);

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
    const shadows = collectShadows(s);
    _warnUnparsedShadows(shadows);
    const findings = warnAppletSkew(shadows);
    if (findings && findings.length) rewritten = rewriteSnapshot(s, findings);
  } catch (_) {}
  _markSnapshotProbed();
  return rewritten;
};
// The loud half of SHADOW_ARG_SPELLINGS: a shadow whose flags could not be read runs
// its host applet with none, so say so where a person or an agent will see it. Once
// per (shadow, reason) per process; a new snapshot in the same session stays quiet.
const _unparsedWarned = new Set();
function _warnUnparsedShadows(shadows){
  for (const sh of shadows || []){
    if (!sh.unparsed) continue;
    const key = sh.name + '\0' + sh.unparsed;
    if (_unparsedWarned.has(key)) continue;
    _unparsedWarned.add(key);
    const known = CLODE_SHADOWS[sh.name];
    // rg never uses upstream's flags: it is always quaude's own rg (rg-entry.cjs), by design.
    const effect = known && known.entry
      ? `rg is quaude's own rg and never uses upstream's flags, so nothing changes`
      : `it runs ${sh.applet} without them`;
    const issue = `clode could not read upstream's flags for the ${sh.name} shadow (${sh.unparsed}); ${effect}`;
    const fix = 'report this with your Claude Code version';
    process.stderr.write(`clode: could not read upstream's flags for the ${sh.name} shadow ` +
      `(${sh.unparsed}); ${effect}. Please ${fix}.\n`);
    _recordSkew({ name: sh.name, applet: sh.applet, why: sh.unparsed, fix, issue });
  }
}
// Rewrite any snapshot-generator command found in a child_process invocation.
// execFile/spawn family: the command string is an element of the args ARRAY (2nd arg).
// exec/execSync family: the command is the FIRST string arg.
const _rewriteArgsArray = (a) => Array.isArray(a) ? a.map(_rewriteSnapshotArg) : a;

// Unpatched spawnSync for warnAppletSkew's own applet probes, so they never
// recurse back through the snapshot-rewrite wrapper installed just below.
const _rawSpawnSync = cp.spawnSync;

// --- rg: every call answered by quaude's rg (rg-native.cjs), never a host rg ---------
// rg lands here as the FILE, not inside the args array, so the snapshot rewrite above
// never saw it. The bundle reaches rg through child_process (execFile for the Grep and
// Glob tools, spawn for the file count and file suggestions) AND through Bun.spawn, so
// every one of those surfaces routes to the same place: rg-native.cjs, whose answer comes
// back as a child of the shape that surface returns (no rg process ever starts).
//
// BY BASENAME (isRgExe). The bundle finds rg as `Bun.which('rg') ?? 'rg'`, which was an
// ABSOLUTE host path whenever the host had ripgrep installed; this used to match only
// `file === 'rg'`, so on such a host every Grep and Glob call ran the HOST's rg (measured
// 2026-09-27). Bun.which('rg') now always answers quaude's own path (RG_PATH, below), and a
// caller may still spell rg any way it likes: the basename decides.
//
// Applies to quaude AND naude, which is the point: bun-shim is baked into both, and it
// wraps whichever object `require('child_process')` is (node-shim's module under quaude,
// node's under naude). Wiring this into node-shim would have made quaude answer rg while
// naude did not — inventing the divergence this project exists to remove.
const _rgNative = require(__dirname + '/rg-native.cjs');
// quaude's rg as a COMMAND (grep-native Task 10c): the Bash tool's `rg` is the shell function rgShadowFunction
// writes, which runs this very binary as rg, and the binary answers as rg-entry.cjs before the bundle loads.
const _rgEntry = require(__dirname + '/rg-entry.cjs');

// QUAUDE'S OWN rg PATH: what Bun.which('rg') answers, always, whatever PATH holds (grep-native Task 10b; user ruling
// 2026-10-03: a PATH STRING ONLY, no file is ever created there). `rg` beside the binary running the bundle (the
// quaude or naude executable; tjs or node under a test). WHY: the bundle resolves rg as `Bun.which('rg') ?? 'rg'`
// (2.1.283's nm/bQ), and its Grep tool (djn) refuses a target outside the working directory when that is not an
// absolute path, telling the model to "Install ripgrep at an absolute path"; with a host rg on PATH it got that rg's
// absolute path and searched, so quaude answered differently by whether the host had ripgrep. With one absolute path
// the bundle takes native's route everywhere: target `.`, the directory as cwd, output made relative, as native's
// embedded rg (an absolute process.execPath) gets. Every rg spawn is answered by quaude's rg by BASENAME (below), so
// nothing ever needs a file there, and anything that execs the path for real meets ENOENT, never a host rg.
// WINDOWS: `rg.exe`, the spelling Bun.which answers there for an installed rg (it keeps the PATHEXT extension; see
// which() below), so the bundle's Windows paths see the shape they see with a host rg, and isRgExe reads it as rg.
const RG_PATH = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg');

// The UNWRAPPED asynchronous spawn the async rg surfaces run their applet with, taken before
// the wrapping below (as _rawSpawnSync is for the synchronous ones).
const _rawSpawn = cp.spawn;

// How quaude's rg reaches its applet: the ugrep it searches with (resolved per call), the unwrapped
// spawns, the refusal when this host has no ugrep, the operator-side surfacing when ugrep fails a search,
// and the CLODE_RG_DEBUG line every call gets. The old rg->ugrep translation is gone, for the spawned rg
// (grep-native Task 10) and for the shell's (Task 10c: the Bash tool's `rg` is rg-entry.cjs): quaude's rg
// answers every search and listing itself, or refuses by name.
const _rgCtx = {
  spawn: _rawSpawn, spawnSync: _rawSpawnSync,
  ugrep: () => process.env.CLODE_UGREP || which('ugrep'),
  missing: () => _rgNative.rgRefusal(_rgAppletMissing(null, 'ugrep', { debug: false }).refuse),
  debug: (args, verdict) => _rgDebug(['rg', ...args], verdict),
  onRejected: (argv, st, pass) => _surfaceRgSkew(argv, st, pass),
};

// A child_process call whose file is rg, in the shape that surface returns. execFile and spawn
// (and Bun.spawn, built on spawn) run the applet ASYNCHRONOUSLY: the event loop keeps turning
// and the caller's signal, kill(), timeout and maxBuffer end the search, as they would end rg.
// Only the synchronous surfaces block, as theirs do in node.
function _rgCall(method, file, args, rest) {
  if (!Array.isArray(args)) { if (args !== undefined) rest.unshift(args); args = []; }
  if (method === 'execFile') {
    const cb = rest.find((x) => typeof x === 'function');
    const opts = rest.find((x) => x && typeof x === 'object') || {};
    return _rgNative.rgExecFile(args, opts, cb, file, _rgCtx);
  }
  const opts = (rest[0] && typeof rest[0] === 'object') ? rest[0] : {};
  if (method === 'spawn') return _rgNative.rgSpawn(args, opts, _rgCtx);
  const r = _rgNative.runRg(args, {
    ..._rgCtx, cwd: opts.cwd, env: opts.env || process.env, input: opts.input, timeout: opts.timeout,
    maxBuffer: opts.maxBuffer, killSignal: opts.killSignal,
  });
  if (method === 'spawnSync') return _rgNative.rgSpawnSync(r, opts);
  return _rgNative.rgExecFileSync(r, opts, file, args);
}

for (const m of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const orig = cp[m];
  if (typeof orig !== 'function') continue;
  cp[m] = function (file, args, ...rest) {
    if (_rgNative.isRgExe(file)) return _rgCall(m, file, args, rest);
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

// --- text: the ONE clustering/width implementation --------------------------
// Bun.stringWidth, Bun.sliceAnsi, Bun.wrapAnsi and Bun.ant.CellSegmenter (below) all come
// from unicode-text.cjs, which travels beside this file in every packaging
// (test/shim-companions.test.cjs), so they can never disagree about a width.
// Bun.stringWidth used to be npm string-width, whose width rules are its own, not
// Bun's (4206 code points differed from native 2.1.278).
//
// Bun.sliceAnsi -- NEW IN 2.1.278, and it is the ONLY Bun member the bundle
// gained between 2.1.251 (the pin until 2026-09-26) and .278 (measured: `Bun\.[A-Za-z_$]\w*`
// over both carves; the two sets differ by this one name). Upstream uses it in
// Ink's text-truncation helper:
//
//     function vo(n,s,u){ let f=Bun.sliceAnsi(n,s,u);
//                         while(u>s && se(f)>u-s) u--, f=Bun.sliceAnsi(n,s,u);
//                         return f }
//
// (and in its line-clipping and the collapsed-output wrap), so EVERY layout pass
// that truncates a string calls it. Undefined here meant a nameless quickjs
// TypeError inside runLayoutPass, which upstream catches, logs as "ink layout pass
// threw ... frame dropped", and swallows -- the TUI then paints NOTHING while the
// process stays alive, answers keystrokes and runs a full turn. `-p` never touches
// this code, which is why every headless floor row stayed green. It used to be npm
// slice-ansi, whose columns, escapes and argument handling are its own (250,673 of
// the text gates' 1,176,930 strings differed from native 2.1.278: negative indices,
// a wide cluster at the cut, styles replayed and closed differently).
//
// Bun.wrapAnsi wraps every Ink text node that wraps (the bundle's wrap helper, from
// Yoga's measure function and again at paint). It used to be npm wrap-ansi, whose
// rules are its own (236,398 of the text gates' 1,182,173 strings differed from native
// 2.1.283: tabs expanded where native keeps them 0 wide, every nested style reopened
// where native carries only the last, CR kept, NFC applied, a wide code point at the
// edge placed differently). The quaude painted a table's italic run onto its borders
// and, below a tabbed code block, bold on the wrong words.
//
// All four are judged against native by test/fidelity/text-differential.test.cjs.
const _ut = require(__dirname + '/unicode-text.cjs');
const stringWidth = _ut.stringWidth;
const sliceAnsi = _ut.sliceAnsi;
const wrapAnsi = _ut.wrapAnsi;

// --- external deps backed by real npm packages -----------------------------
// stripANSI (and semver, below) are backed by the npm strip-ansi / semver
// packages -- no in-house clones.
// They render every frame / gate versions, so a missing one is FATAL: write the
// install hint and exit (nothing to recover, unlike the optional ws/yaml features).
// require() resolves these even though strip-ansi is ESM-
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

const _stripAnsiFn   = _extResolve('strip-ansi');
function stripANSI(...a){ return _stripAnsiFn ? _stripAnsiFn(...a) : _extFatal(_extMissing('strip-ansi', 'text rendering (ANSI stripping)')); }
// Without the real module this is a fail-loud stub, not an implementation -- tag so
// inspect-claude-bundle coverage reports it honestly (see Bun.YAML).
if (!_stripAnsiFn) stripANSI.__bunShimStub = true;

// --- rewriteSnapshot: rewrite Claude Code's grep/find/rg shell-snapshot shadows
// to run the REAL host applet instead of the upstream native multiplexer (which
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
          skewRcTest: '[ "$_rc" -ne 0 ]',
          // FIND_WITHOUT_ONIGURUMA (see warnAppletSkew): the one flag a bfs without
          // Oniguruma cannot take, and the find arguments that depend on it.
          degrade: { drop: ['-regextype', 'findutils-default'], refuseArgs: ['-regex', '-iregex', '-regextype'] } },
  // rg: quaude's own rg, the COMMAND (rg-entry.cjs; grep-native Task 10c, user ruling 2026-10-04): the shadow is
  // upstream's own shape run against this binary as rg, so there is no host applet to name, override or probe, and
  // upstream's flags (it bakes in none for rg) are never used.
  rg:   { applet: 'rg', entry: true },
};

// A shadow body is the upstream multiplexer if it invokes an applet via argv0
// against the provider binary. We detect the applet from ARGV0=/exec -a.
const SHADOW_APPLET = new RegExp(_SHADOW_INVOKE + '([A-Za-z0-9_+-]+)\\b');

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

// SHADOW_ARG_SPELLINGS — the rule: an upstream shadow's applet call is
// `"$_cc_bin" <flags> <args>`, where <args> is one of these spellings, and the flags
// are everything in between. Every carve on the dev box from 2.1.185 to 2.1.283
// (both the darwin and linux-x64 snapshot writers) spells it `${1+"$@"}`; `"$@"` is
// the spelling test/fixtures/snapshot-execpath.sh and snapshot-installpath.sh carry.
// Only `"$@"` was known until 2026-09-27, so against every real snapshot the rewrite
// read "no flags": the Bash tool's grep searched .gitignored files, find ran without
// its regex type, and the skew probe had nothing to probe. A call that ends in
// anything else, flags that expand shell text (`$`, a backtick), or branches
// (zsh/msys/bash) that disagree, are UNPARSED, never "no flags": the shadow is still
// routed to the host applet, a comment in its body says the flags could not be read,
// and the rewrite warns on stderr and records it for /doctor (_warnUnparsedShadows).
const SHADOW_ARG_SPELLINGS = ['${1+"$@"}', '"$@"'];
const _SHADOW_CALL = new RegExp(_SHADOW_INVOKE + '[A-Za-z0-9_+-]+\\s+"\\$_cc_bin"(.*)$');
function _shadowCallFlags(body){
  const seen = new Set();
  for (const line of body.split('\n')) {
    const m = _SHADOW_CALL.exec(line);
    if (!m) continue;
    let tail = m[1].trim();
    if (/^\s*\(\s*exec -a /.test(line) && tail.endsWith(')')) tail = tail.slice(0, -1).trim();
    const spelling = SHADOW_ARG_SPELLINGS.find((a) => tail === a || tail.endsWith(' ' + a));
    if (spelling === undefined) return { unparsed: `unknown argument spelling in: ${tail}` };
    const flags = tail.slice(0, tail.length - spelling.length).trim();
    // Flags are copied into a function that has none of upstream's locals, so a flag
    // that expands anything ($x, `cmd`, $(cmd)) would expand to something else there.
    if (/[$`]/.test(flags)) return { unparsed: `flags expand shell text: ${flags}` };
    seen.add(flags);
  }
  if (seen.size === 0) return { unparsed: 'no applet call on "$_cc_bin"' };
  if (seen.size > 1) return { unparsed: `branches disagree: ${[...seen].join(' | ')}` };
  return { flags: [...seen][0] };
}

// Pull the applet + the flag string (see SHADOW_ARG_SPELLINGS) out of a shadow body,
// plus the optional passthrough `for _cc_a ... done` guard. Returns null if the body
// is not an upstream multiplexer shadow.
function parseShadow(body){
  const am = SHADOW_APPLET.exec(body);
  if (!am || !/_cc_bin|CLAUDE_CODE_EXECPATH|\/claude\b/.test(body)) return null;
  const applet = am[1];
  const call = _shadowCallFlags(body);
  const gm = /(\s*local _cc_a[\s\S]*?\n\s*done\n)/.exec(body);
  const guard = gm ? gm[1] : '';
  const parsed = { applet, flags: call.flags || '', guard };
  if (call.unparsed) parsed.unparsed = call.unparsed;
  return parsed;
}

// Embed arbitrary text as a single shell word: single-quote it, escaping any
// embedded single quote with the classic '\'' dance. The skew `why` is the host
// applet's own stderr line, so it can contain anything.
function shQuote(s){ return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// SHADOW_KEEPS_THE_SHELL — the rule: a shadow runs its applet as a CHILD and
// returns the applet's status; it never replaces the shell that called it.
// There is no "function's subshell" to replace: the Bash tool sources the snapshot
// and evals the model's whole command in ONE shell, and a shadow is a FUNCTION in
// that shell, so `exec` in its body ended the entire command — `grep -q x f &&
// echo A; echo B` printed neither echo (found by the NetBSD spike, 2026-09-26; true
// everywhere, bash and zsh). Upstream's shadow never replaces the caller either
// (`ARGV0=ugrep …` is a child in zsh; bash gets `(exec -a ugrep …)`, a subshell),
// so this is the diff-reducing shape. The applet inherits stdin/stdout/stderr and
// its status is the function's status. test/shadow-keeps-the-shell.test.cjs holds
// every shadow shape to it, in bash and in zsh.
//
// Build the replacement shadow. Without a skew finding: run the host applet and
// return its status. WITH a finding (the generation-time probe saw this applet
// reject these flags): capture the exit code, and on a skew-shaped failure print a
// self-explaining line — the probe's exact why + the applet-specific fix — to
// stderr right where the cryptic applet error lands, then propagate the
// applet's own exit code. This is the host-applet (foundation) configuration's
// answer to skew: the diagnosis travels to the point of use, visible to the
// user and to any agent reading the failed command's output. A status above 128 is
// a signal, never skew: `grep ... | head -1` ends the applet with SIGPIPE (141),
// which `[ "$_rc" -ge 2 ]` alone read as a usage error.
function buildShadow(name, known, parsed, finding){
  if (known.entry) return _rgEntry.rgShadowFunction(process.execPath); // rg: quaude's own rg, run as rg (rg-entry.cjs)
  const { applet, env } = known;
  const flags = parsed.flags ? ' ' + parsed.flags : '';
  const head = `function ${name} {\n` +
    parsed.guard +
    (parsed.unparsed ? `  # clode: could not read upstream's flags for ${name} (${parsed.unparsed.replace(/\n/g, ' ')}); running ${applet} with none\n` : '') +
    `  local _bin="\${${env}:-$(command -v ${applet} 2>/dev/null)}"\n` +
    `  [ -n "$_bin" ] || { echo "clode: ${name} needs '${applet}' (set ${env} or install it)" >&2; return 127; }\n`;
  if (!finding) return head + `  "$_bin"${flags} "$@"\n}`;
  if (finding.degraded){
    // FIND_WITHOUT_ONIGURUMA: run without the dropped flag; refuse only the arguments
    // that depend on it.
    const refusal = shQuote(
      `clode: this ${name} uses a regex, and the host ${applet} cannot read upstream's ` +
      `\`${finding.degraded.dropped}\`, so the regex would silently mean something else. ` +
      `${finding.fix}.`);
    const reduced = finding.degraded.flags ? ' ' + finding.degraded.flags : '';
    return head +
      `  local _cc_a\n` +
      `  for _cc_a in "$@"; do\n` +
      `    case "$_cc_a" in ${known.degrade.refuseArgs.join('|')}) printf '%s\\n' ${refusal} >&2; return 1 ;; esac\n` +
      `  done\n` +
      `  "$_bin"${reduced} "$@"\n` +
      `}`;
  }
  const msg = shQuote(
    `clode: known applet skew — host ${applet} rejects the flags this ${name} shadow uses ` +
    `(${finding.why}). ${finding.fix}.`);
  return head +
    `  "$_bin"${flags} "$@"\n` +
    `  local _rc=$?\n` +
    `  ${known.skewRcTest} && [ "$_rc" -le 128 ] && printf '%s\n' ${msg} >&2\n` +
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
// trailer instead of the plain run. Omitted/empty = the pure rewrite.
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
  // rg is never ADDED (grep-native Task 10c): the writer's own rg line, inside upstream's "is rg installed?" guard,
  // is where rg is defined, in every mode, as native defines it (_rewriteRgOwnAlias, below). A host rg wins there.
  return _rewriteRgOwnAlias(out);
}

// QUAUDE'S OWN rg ALIAS LINE, and no other (grep-native Task 10b fix round, review I-1/I-2). With no argv0, the
// snapshot writer (2.1.283's aAn) spells rg as an alias of the resolved rg inside upstream's "no host rg" guard,
// `alias rg='<rgPath>'`, and that path is RG_PATH: a path string with no file. zsh expands aliases in the sourced
// snapshot, and so does bash (the writer starts its snapshot with `shopt -s expand_aliases`), so `rg` would run the
// missing file; with --allowedTools naming Grep or Glob there are no find/grep shadows either, so nothing else
// defines rg. That line, recognised by its value being RG_PATH, becomes quaude's rg shadow, in the generator and in a
// written snapshot alike. Any other rg alias, a user's own above all, is left alone: native honours it, and so must we.
// THE SHADOW IS NATIVE'S (grep-native Task 10c, user ruling 2026-10-04): with an argv0 the writer spells rg as the
// function dbe("rg", argv0), written by the heredoc below (`cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'`, the
// function indented two spaces as the writer's template indents it), and rg-entry.cjs's rgShadowFunction is that
// function run against this binary. It stays where the alias was, INSIDE upstream's guard, so a host rg wins, in
// every mode, as it wins for native; it is never added anywhere else (rewriteSnapshot).
const _RG_ALIAS_LINE = /^([ \t]*)(?:echo '  alias rg='"'((?:[^'"\n]|'\\'')*)'" >> "\$SNAPSHOT_FILE"|alias rg='((?:[^'\n]|'\\'')*)')[ \t]*$/gm;
function _rgAliasValue(m) {
  let v = (m[2] !== undefined ? m[2] : m[3]).split("'\\''").join("'");
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") v = v.slice(1, -1).split(`'"'"'`).join("'");  // the writer's qr quoting
  return v;
}
function _rgOwnAliasAt(text) {
  for (const m of String(text).matchAll(_RG_ALIAS_LINE)) if (_rgAliasValue(m) === RG_PATH) return m.index;
  return null;
}
function _rewriteRgOwnAlias(text) {
  return String(text).replace(_RG_ALIAS_LINE, (...a) => {
    const m = a.slice(0, 4);
    if (_rgAliasValue(m) !== RG_PATH) return a[0];
    const fn = _rgEntry.rgShadowFunction(process.execPath);
    return m[2] !== undefined
      ? `${m[1]}cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'\n  ${fn}\nRIPGREP_FUNC_END`
      : `${m[1]}${fn}`;
  });
}

// Parse (without rewriting) the known search shadows present in a snapshot, for
// the skew probe. Unknown applets are skipped here — rewriteSnapshot already
// throws on them before we ever probe.
function collectShadows(text){
  const out = [];
  _eachShadow(String(text), ({ name, parsed }) => {
    const known = CLODE_SHADOWS[name];
    if (known && known.applet === parsed.applet){
      const sh = { name, applet: known.applet, env: known.env, flags: parsed.flags };
      if (parsed.unparsed) sh.unparsed = parsed.unparsed;
      out.push(sh);
    }
  });
  return out;
}

// After rewriting a shadow to run the host applet, confirm that applet actually
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
// Loud, at the point of use: ugrep failed quaude's rg's search at runtime.
// exit >=2 only (1 == no match). Records to /doctor so the app's fallback can't hide it.
// `pass`: which of quaude's rg's own ugrep runs failed (its 'match pass'): the message says so.
function _surfaceRgSkew(rewritten, status, pass){
  if (!(status >= 2)) return;
  const key = rewritten.join('\0');
  if (_rgSurfaced.has(key)) return;
  _rgSurfaced.add(key);
  const why = `host ugrep exited ${status} in quaude's rg's ${pass}: ${rewritten.join(' ')}`;
  process.stderr.write(`clode: quaude's rg could not search — ${why}\n` +
    `       file an issue with this search.\n`);
  _recordSkew({ name: 'rg', applet: 'ugrep', why, fix: `quaude's rg (libexec/rg-native.cjs): its ugrep ${pass} failed` });
}
// FIND_WITHOUT_ONIGURUMA — the rule (the user's decision, 2026-09-27: "drop only that
// flag"): when the host bfs rejects upstream's `-regextype findutils-default` but accepts
// the rest of upstream's find flags, the rewritten find runs WITHOUT that one flag, and
// refuses (exit 1, with the fix) only a find whose own arguments include -regex, -iregex
// or -regextype, which would otherwise silently read its regex in another dialect (e.g.
// `\(a\|b\)` is a GNU basic-regex extension macOS's libc lacks). Every other find runs,
// `-S dfs` kept, so its results and order match native. Only a bfs built with Oniguruma
// knows findutils-default; pkgsrc builds bfs --without-oniguruma. A written divergence
// from upstream's argv (CHANGELOG.md, BACKLOG.md). Returns the reduced flag set, or null
// when there is nothing to drop or the host rejects the rest too (then the whole shadow
// keeps the every-invocation skew trailer).
function _degradeFlags(known, flags, bin, spawn){
  const d = known.degrade;
  if (!d) return null;
  const at = flags.findIndex((f, i) => d.drop.every((x, j) => flags[i + j] === x));
  if (at === -1) return null;
  const reduced = [...flags.slice(0, at), ...flags.slice(at + d.drop.length)];
  const { args, skew } = known.probe(reduced);
  let r;
  try { r = spawn(bin, args, { encoding: 'utf8', timeout: 5000 }); } catch (_) { return null; }
  if (r.error || skew(r.status)) return null;
  return { flags: reduced.join(' '), dropped: d.drop.join(' ') };
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
      const degraded = _degradeFlags(known, flags, bin, spawn);
      const finding = degraded
        ? { name: sh.name, applet: sh.applet, fix, degraded,
            why: `${why} (${sh.name} still works; only a ${known.degrade.refuseArgs.join(', ').replace(/, ([^,]*)$/, ' or $1')} ${sh.name} refuses)` }
        : { name: sh.name, applet: sh.applet, why, fix };
      _skewProbed.set(key, finding);
      _recordSkew(finding);
      found.push(finding);
      process.stderr.write(degraded
        ? `clode: host ${sh.applet} rejects \`${degraded.dropped}\` — \`${sh.name}\` works without it, ` +
          `but a ${sh.name} using ${known.degrade.refuseArgs.join(', ').replace(/, ([^,]*)$/, ' or $1')} will refuse:\n` +
          `       ${why}\n` +
          `       ${fix}.\n`
        : `clode: host ${sh.applet} rejects the flags Claude's embedded ${sh.applet} uses — ` +
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
// The shell path agrees: the Bash tool's `rg` is quaude's own rg too (rg-entry.cjs,
// grep-native Task 10c), whose refusal with no ugrep is this one (rg-native.cjs's),
// never a host rg; the same two-routes-disagreeing bug fixed in e356a20, one level up,
// stays fixed.
//
// It is a REFUSAL (rg-native.cjs rgRefusal: rc 2, the reason on stderr), not an argv
// that cannot resolve. The unresolvable argv this used to return made the bundle's own
// not-found fallback tell the MODEL "ripgrep not found on PATH. Install it ...", which is
// the one remedy quaude refuses on purpose.
function _rgAppletMissing(cmd, applet, { debug = true } = {}) {
  process.stderr.write(
    `clode: rg needs '${applet}' (set CLODE_${applet.toUpperCase()} or install it); `
    + 'not falling back to a host rg — quaude translates rg to portable applets on purpose\n');
  if (debug) _rgDebug(cmd, `!! needs ${applet}`);
  return { refuse: `quaude answers rg with ${applet}, on purpose, and this host has no ${applet} `
    + `(set CLODE_${applet.toUpperCase()} or install ${applet}); nothing was searched` };
}

// ONE parseable line per rg call the shim sees, whatever the outcome:
//
//   clode rg-debug: <rg argv> => quaude's rg over <ugrep>   answered (rg-native.cjs rgPlan)
//   clode rg-debug: <rg argv> !! needs ugrep                this host has no ugrep
//   clode rg-debug: <rg argv> !! untranslatable <flag>      a flag quaude's rg refuses by name
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

// --- spawn: approximate Bun.spawn -> Node child_process ---
function spawn(cmdOrOpts, maybeOpts){
  let cmd, opts;
  if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts||{}; }
  else { opts = cmdOrOpts||{}; cmd = opts.cmd; }
  const exe = cmd[0];
  // rg is never looked up: cp.spawn (wrapped above) answers it with quaude's rg, whether
  // or not the host has one.
  const isRg = _rgNative.isRgExe(exe);
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
  if (isRg) {
    // answered by quaude's rg, below; nothing to find
  } else if (exe && !_exeIsPathed(exe, process.platform === 'win32')) {
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
// rg needs nothing here: cp.spawnSync (wrapped above) answers it with quaude's rg.
spawn.sync = function(cmdOrOpts){
  const cmd = Array.isArray(cmdOrOpts)?cmdOrOpts:(cmdOrOpts.cmd);
  const r = cp.spawnSync(cmd[0], cmd.slice(1), {encoding:'buffer'});
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
// missing-applet path (see _rgAppletMissing) even with ugrep sitting right
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
  // rg is quaude's own, never the host's: one absolute path (RG_PATH, above), and that path answers itself (the
  // sandbox's dependency check asks Bun.which(<its rg command>)).
  if (bin === 'rg' || bin === RG_PATH) return RG_PATH;
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


// --- Bun.ant.CellSegmenter -------------------------------------------------
// Upstream 2.1.278 moved Ink's screen model onto a NATIVE grapheme->cell
// segmenter that exists only inside Anthropic's private Bun build. Unlike every
// other Bun.ant member (see the note beside `spawnSync`), absence is NOT an
// acceptable answer: `class Mf { native = vs(qot) }` constructs it from a
// class-field initialiser with no flag and no fallback, so without it every
// frame throws out of onRender and quaude paints a blank screen.
//
// THE CALLER IS THE SPEC. The whole contract is derived in
// BACKLOG.md from the three call sites that exist in the 1958-module bundle
// (`Mf.native`, the `A0 ??= vs([])` singleton `px()` uses only for setCell, and
// `Mf.resetNative()`), and it separates what the caller OBSERVES from what it
// never looks at. What it never looks at, we choose. In particular:
//   - how cells[2i] encodes a grapheme is ours (any index into our own
//     `graphemes`), because only our own paint() reads it back;
//   - whether a wide grapheme takes one scratch cell or two is ours, because
//     width() SUMS advances and nothing counts cells per grapheme. We use ONE
//     cell carrying the full advance, and paint() emits the spacer.
//
// What IS observed, and must match native exactly:
//   scratch cells[2i+1]:  bits 0-7 advance columns, bit 8 "this is a TAB"
//                         (advance is tabWidth - col%tabWidth), bits 10+ run index
//   runs[2j] / runs[2j+1]: index into sgrKeys/sgrCloseKeys, index into uris,
//                         with 0 RESERVED in both ("no style" / "no hyperlink")
//   the pools:            live, indexable, append-only JS arrays of strings whose
//                         indices are stable for the life of the instance (the
//                         caller memoises styleIds[i]/linkIds[i] across frames)
//   paint()/setCell() return: a double packing
//                         endColumn | damageX1<<20 | damageX2<<36
//   every screen cell written: BOTH slots, char index and packed word.
//
// SCOPE, STATED SO IT IS MEASURABLE RATHER THAN SILENT. Phases 1 and 2 built the
// contract above; phase 3 made the TEXT native's, and phase 4 its LINKS:
//   - CLUSTERS AND WIDTHS are native CellSegmenter's own, from the ONE
//     implementation in unicode-text.cjs (its `bun-cell` profile, NOT the UAX #29
//     that Intl.Segmenter follows: native's two clusterers disagree), together
//     with the layers native runs around its clusterer, stated there once: the
//     ESCAPE LAYER (ESC and the six C1 introducers, taken out before clustering, so
//     a cluster can span an escape), and the CELL rules (TAB, no cell for a
//     zero-width cluster, 255 saturation, `substitute`). Judged against native
//     2.1.278 over every code point, every escape-parser state, emoji-test and the
//     bundle's own literals by test/fidelity/text-differential.test.cjs.
//   - STYLES are native's too: which SGR opens, closes and replaces what, how each
//     style is spelled and in what order the run's key lists them are unicode-text.cjs's
//     SGR- and CELL-SGR rules, judged by the same gate on the style the caller PAINTS
//     (each cell's key through its own ansiCodes()/SC filter, close codes included).
//   - HYPERLINKS are native's too: which OSC is a link is unicode-text.cjs's OSC-8
//     rule (the one Bun.sliceAnsi's SLICE-LINKS reads as well), and which cell takes
//     it, what `uris` holds and when a URI is interned is CELL-LINK. Judged by the
//     same gate on the link the caller PAINTS (each cell's run's uris entry, as
//     runWords() reads it), and on the screen by the frame gate's link scene
//     (test/fidelity/interactive-frame-diff.test.cjs, tui-reply-hyperlinks).
//   - PAINT() AND SETCELL() are native's too (phase 5): every screen cell they write and
//     every packed triple they return, damage included, by the rules stated at paint()
//     below, judged against native by test/fidelity/paint-differential.test.cjs.
// What is still NOT native's is named in BACKLOG.md's CellSegmenter section (phase 5:
// the stateful surfaces; phase 6: `reordered`, and performance).

// Pool interning. The pools are ARRAYS because the caller indexes and .length
// them directly; the Map beside each is ours and never escapes.
function _csIntern(pool, index, s) {
  let i = index.get(s);
  if (i === undefined) { i = pool.length; pool.push(s); index.set(s, i); }
  return i;
}

// PAINT-DAMAGE's x1 when nothing was written: the largest value its 16 bits hold.
const _CS_NO_DAMAGE_X1 = 65535;

class _CellSegmenter {
  constructor(options) {
    const o = options || {};
    const s = o.screen || {};
    // ambiguousIsNarrow picks the width of East Asian Ambiguous code points (and of
    // U+FFFD for a substituted one). The bundle only ever passes `true` and never
    // re-reads it; the text differential judges both settings' widths.
    this.ambiguousIsNarrow = o.ambiguousIsNarrow !== false;
    this.widthMask = s.widthMask === undefined ? 3 : s.widthMask;
    this.narrow = s.narrow === undefined ? 0 : s.narrow;
    this.wide = s.wide === undefined ? 1 : s.wide;
    this.spacerTail = s.spacerTail === undefined ? 2 : s.spacerTail;
    // spacerHead (3) is what native paints in place of a wide cluster that does not
    // fit before the right edge (PAINT-EDGE-WIDE, measured 2026-09-25). The bundle's
    // readers treat 2 and 3 alike and Yd's blit fixups test only for 2, but the screen
    // is judged cell by cell against native, so 3 is written exactly where native
    // writes it.
    this.spacerHead = s.spacerHead === undefined ? 3 : s.spacerHead;
    this.emptyCharIndex = s.emptyCharIndex === undefined ? 0 : s.emptyCharIndex;
    this.spacerCharIndex = s.spacerCharIndex === undefined ? 1 : s.spacerCharIndex;
    this.emptyWord = s.emptyWord === undefined ? 0 : s.emptyWord;
    this.tabWidth = s.tabWidth === undefined ? 8 : s.tabWidth;

    // `substitute` is a list of codepoint RANGES shown as U+FFFD — the bidi
    // controls (ALM, LRE..RLO/PDF, LRI..PDI). The module's own JS twin Ec()
    // replaces exactly those. px()'s singleton passes [], i.e. no substitution.
    // A substituted code point also STANDS ALONE (no Prepend takes it, no mark
    // joins it): CELL-SUBSTITUTE in unicode-text.cjs, measured.
    this.substitute = [];
    if (Array.isArray(o.substitute)) {
      for (const r of o.substitute) {
        if (Array.isArray(r) && r.length >= 2) this.substitute.push([r[0], r[1]]);
      }
    }

    // The four pools the caller holds references to. They must be the SAME
    // objects for the life of the instance and must grow IN PLACE: the caller
    // caches them in fields and re-reads them only in its constructor and in
    // resetNative(), which builds a whole new segmenter.
    //
    // Index 0 is RESERVED in sgrKeys/sgrCloseKeys ("no style": ansiCodes(0)
    // short-circuits without reading sgrKeys[0], and styleId(0) is the
    // cached-style sentinel) and in uris ("no hyperlink": the caller skips
    // interning when runs[2j+1] === 0). `graphemes` reserves nothing.
    this.graphemes = [];
    this.sgrKeys = [''];
    this.sgrCloseKeys = [''];
    this.uris = [''];
    this._gIndex = new Map();
    this._sgrIndex = new Map([['', 0]]);
    this._uriIndex = new Map([['', 0]]);
    // The damage span of the paint() or setCell() in progress (PAINT-DAMAGE).
    this._dx1 = _CS_NO_DAMAGE_X1;
    this._dx2 = 0;
  }

  // The style key for the styles in force: their NUL-joined open spellings and the
  // parallel NUL-joined close codes, in their order. What the styles are, how they are
  // spelled and in what order they stand is CELL-SGR in unicode-text.cjs (measured
  // against native); ORDER IS OBSERVED (the caller interns the decoded list and the
  // interned identity is order-sensitive) and so are the close codes (compared by
  // identity against its fixed set; a wrong one is not cosmetic: `sx` and
  // withSelectionBg filter on 49m/27m, so it changes selection highlighting), and the
  // caller's ansiCodes() paints only the entries its SC regex accepts, so an entry SC
  // refuses still takes its attribute's place: native's own `ESC[4:3m` after `ESC[4m`
  // leaves the cell NOT underlined, and so does ours.
  _sgrIndexOf(styles) {
    if (styles.length === 0) return 0;
    let open = styles[0].open, close = styles[0].close;
    for (let i = 1; i < styles.length; i++) {
      open += '\x00' + styles[i].open;
      close += '\x00' + styles[i].close;
    }
    let i = this._sgrIndex.get(open);
    if (i === undefined) {
      i = this.sgrKeys.length;
      this.sgrKeys.push(open);
      this.sgrCloseKeys.push(close);
      this._sgrIndex.set(open, i);
    }
    return i;
  }

  // segment(text, cells, runs, reordered) -> cellCount, or -needed to grow.
  //
  // The caller reallocates BOTH buffers to 2*max(-u, oldLength) ints and calls
  // again exactly ONCE — it does not loop — so the negative value has to
  // guarantee the retry succeeds. -cellCount is sufficient and minimal;
  // anything smaller is a silent screen corruption, not an error.
  //
  // `reordered` is the caller's xf(), true only under Windows Terminal and
  // VS Code's terminal. We never reorder, so we ignore it: when it is true the
  // caller merely stops assuming run indices are monotonic and scans all cells
  // for the max, which costs correctness nothing.
  segment(text, cells, runs, _reordered) {
    const cap = cells.length >>> 1;
    const runCap = runs.length >>> 1;
    const str = typeof text === 'string' ? text : String(text == null ? '' : text);

    const styles = [];         // the styles in force, in order (CELL-SGR)
    let sgrIdx = 0;            // index into sgrKeys for `styles`
    let uriIdx = 0;            // index into uris; 0 = no hyperlink (see SCOPE)
    let runIdx = -1;           // last emitted run
    let runSgr = -1, runUri = -1;
    let count = 0;             // scratch cells needed (written while <= capacity)
    let runCount = 0;
    let overflow = false;

    const emit = (graphemeIdx, word) => {
      if (runIdx < 0 || runSgr !== sgrIdx || runUri !== uriIdx) {
        if (runCount >= runCap) overflow = true;
        else { runs[runCount * 2] = sgrIdx; runs[runCount * 2 + 1] = uriIdx; }
        runIdx = runCount++;
        runSgr = sgrIdx; runUri = uriIdx;
      }
      if (count >= cap) overflow = true;
      else { cells[count * 2] = graphemeIdx; cells[count * 2 + 1] = word | (runIdx << 10); }
      count++;
    };

    // THE TEXT IS unicode-text.cjs's, stated there once: its escape layer takes ESC
    // and the C1 introducers' sequences out, and its cells are native's bun-cell
    // clusters with the TAB, zero-width, 255-saturation and substitute rules. What is
    // left here is the caller's encoding. A cell's style and link are the ones in force
    // where its cluster STARTS — a cluster can span an escape (measured: `e ESC[1m
    // U+0301 x` is `e U+0301` unstyled, then `x` bold; the same for a link) — so a
    // sequence applies before the first cell whose cluster starts at or after it.
    const { text: visible, sequences } = _ut.escapeLayer(str);
    const apply = (q) => {
      // An SGR: a CSI that ENDED at `m` and met nothing it could not hold (an ignored CSI
      // is consumed and never applied: ESCAPE-LAYER). What it does is CELL-SGR's.
      if (q.kind === 'csi' && q.final === 'm' && !q.ignored) { _ut.cellSgr(styles, q.params); sgrIdx = this._sgrIndexOf(styles); }
      // A hyperlink: which OSC is one is OSC-8's, what it does CELL-LINK's. Its URI is
      // interned as it is read; '' (a close) is index 0, no link.
      else if (q.kind === 'osc') {
        const uri = _ut.oscLink(q.params, q.final);
        if (uri !== null) uriIdx = _csIntern(this.uris, this._uriIndex, uri);
      }
    };
    let next = 0;
    _ut.forEachCell(visible, this.ambiguousIsNarrow, this.substitute, (g, advance, tab, at) => {
      for (; next < sequences.length && sequences[next].at <= at; next++) apply(sequences[next]);
      // TAB: bit 8 says "advance is tabWidth - col%tabWidth", which only the
      // consumer (width(), or our paint()) can resolve because it depends on the
      // column. The low advance bits are unread for a tab; keep them 0.
      emit(_csIntern(this.graphemes, this._gIndex, g), tab ? 256 : advance);
    });
    // After the last cell: native still interns the URI of a link it reads there
    // (CELL-LINK), but no style key, because native keys only a style a cell has. This
    // shim does not match that mid-string: apply() interns every intermediate style as it
    // applies it (`ESC[1m ESC[0m a` leaves two keys, native one). A recorded divergence:
    // BACKLOG.md, `Bun.ant.CellSegmenter` section, "Style keys for styles no cell has".
    for (; next < sequences.length; next++) if (sequences[next].kind === 'osc') apply(sequences[next]);

    if (overflow) return -count;
    return count;
  }

  // paint(screenCells, screenWidth, x, y, segCells, count, _unused, charIndices,
  //       runWords) -> endColumn | damageX1<<20 | damageX2<<36
  //
  // The 7th argument is ALWAYS undefined at the only call site, so its meaning
  // is unobservable; recorded as a freedom rather than a mystery.
  //
  // CLIPPING IS PAINT'S JOB: the caller passes an x that may exceed the screen
  // width and the full cell count regardless of how much fits.
  //
  // WHAT IT WRITES AND RETURNS IS NATIVE'S, measured against native 2.1.278 (Bun 1.4.3,
  // 2026-09-25) over scripts/lib/paint-corpus.cjs by test/fidelity/paint-differential.test.cjs,
  // every screen cell and every packed triple, damage included: the bundle repaints only
  // inside the damage it is told, so a rect narrower than native's leaves a stale cell for a
  // frame. Each rule below is pinned by a same-named test in
  // test/bun-shim-cell-segmenter.test.cjs. Every measurement agrees with the JS painter
  // native replaced (2.1.251's line writer: a tab's blanks, the spacerHead at the edge;
  // over its one-cell writer: the clean-up of a split wide cluster), with the damage of
  // every cell written; that one-cell writer is _csWrite() here, and is setCell() too.
  paint(screenCells, screenWidth, x, y, segCells, count, _unused, charIndices, runWords) {
    this._dx1 = _CS_NO_DAMAGE_X1; this._dx2 = 0;
    let col = x;
    for (let i = 0; i < count; i++) {
      const w = segCells[(i << 1) + 1];
      if ((w & 256) !== 0) {
        // PAINT-TAB (rule): a tab writes blank cells (emptyCharIndex, emptyWord: no style, no
        //   link) up to its stop, tabWidth - col % tabWidth on with the remainder truncated as
        //   JS truncates it (so from a column left of the screen the stop is further), and never
        //   past the right edge, where it advances nothing.
        const stop = col + this.tabWidth - (col % this.tabWidth);
        for (; col < stop && col < screenWidth; col++) {
          this._csWrite(screenCells, screenWidth, y, col, this.emptyCharIndex, this.emptyWord);
        }
        continue;
      }
      const adv = w & 255;
      if (adv === 0) continue;               // zero-width: no cell of its own
      if (adv >= 2 && col + adv > screenWidth) {
        // PAINT-EDGE-WIDE (rule): a cluster wider than 1 that does not fit before the right
        //   edge paints one spacerHead cell (emptyCharIndex, emptyWord) and advances 1, past the
        //   edge as well, where it writes nothing.
        this._csWrite(screenCells, screenWidth, y, col, this.emptyCharIndex, this.emptyWord | this.spacerHead);
        col++;
        continue;
      }
      const word = runWords[w >>> 10];
      this._csWrite(screenCells, screenWidth, y, col, charIndices[segCells[i << 1]],
        word | (adv >= 2 ? this.wide : this.narrow));
      // PAINT-SPACERS (rule): a cluster wider than 2 writes its columns after the second as
      //   spacerTail cells carrying the run's word, its style and link.
      for (let k = 2; k < adv; k++) {
        this._csWrite(screenCells, screenWidth, y, col + k, this.spacerCharIndex, word | this.spacerTail);
      }
      col += adv;
    }
    // PAINT-END (rule): paint's end column is x plus the advance of every cell as the rules
    //   above paint it, whether or not it was written.
    return _csPack(col, this._dx1, this._dx2);
  }

  // setCell(screenCells, screenWidth, x, y, charIndex, word) -> the same packed
  // triple, of which only the damage half is read. The word arrives ALREADY
  // PACKED, width bits included: setCell segments nothing and touches no pool.
  // It is paint()'s one-cell writer on its own (measured): the word is written as
  // given, and a wide one splits and spaces exactly as a painted one does.
  setCell(screenCells, screenWidth, x, y, charIndex, word) {
    this._dx1 = _CS_NO_DAMAGE_X1; this._dx2 = 0;
    this._csWrite(screenCells, screenWidth, y, x, charIndex, word);
    // SETCELL-END (rule): setCell's end column is x + 1, on the screen or off it, whatever the
    //   word's width.
    return _csPack(x + 1, this._dx1, this._dx2);
  }

  // Write one screen cell as native does, and count its damage: every cell paint()
  // writes, and setCell().
  _csWrite(cells, width, y, c, charIndex, word) {
    // SCREEN-BOUNDS (rule): only a column in [0, width) of a row in [0, height) is written,
    //   the height being the screen array's own (cells.length / 2 / width), and a wide cell
    //   that is not written writes no spacer either.
    if (c < 0 || c >= width || y < 0 || (y + 1) * width * 2 > cells.length) return;
    const k = (y * width + c) << 1, m = this.widthMask;
    const was = cells[k + 1] & m, now = word & m;
    // SCREEN-ORPHANS (rule): a write that splits a wide cluster clears the half it leaves to
    //   an empty cell (emptyCharIndex, emptyWord): the spacerTail right of a head overwritten
    //   by anything but a head, the head left of a spacerTail overwritten by anything but a
    //   spacerTail, and the spacerTail of a head that a wide cell's own spacer lands on.
    if (was === this.wide && now !== this.wide && c + 1 < width
        && (cells[k + 3] & m) === this.spacerTail) this._csClear(cells, k + 2, c + 1);
    if (was === this.spacerTail && now !== this.spacerTail && c > 0
        && (cells[k - 1] & m) === this.wide) this._csClear(cells, k - 2, c - 1);
    cells[k] = charIndex;
    cells[k + 1] = word;
    this._csDamage(c);
    if (now !== this.wide || c + 1 >= width) return;
    if ((cells[k + 3] & m) === this.wide && c + 2 < width
        && (cells[k + 5] & m) === this.spacerTail) this._csClear(cells, k + 4, c + 2);
    // SCREEN-SPACER (rule): a wide cell takes the next column, when it is on the screen, as a
    //   spacerTail cell with emptyWord (no style, no link). spacerTail (2) is the ONLY spelling
    //   of "second half of a wide cluster": Yd()'s blit fixups test for width===1 followed by
    //   width===2, so any other spelling corrupts clipped blits.
    cells[k + 2] = this.spacerCharIndex;
    cells[k + 3] = this.emptyWord | this.spacerTail;
    this._csDamage(c + 1);
  }

  _csClear(cells, k, c) {
    cells[k] = this.emptyCharIndex;
    cells[k + 1] = this.emptyWord;
    this._csDamage(c);
  }

  // PAINT-DAMAGE (rule): the damage paint() and setCell() return spans every column they
  //   wrote, a write of the value already there and a cell SCREEN-ORPHANS clears included,
  //   and with none written is x1 = 65535, x2 = 0.
  _csDamage(c) {
    if (c < this._dx1) this._dx1 = c;
    if (c + 1 > this._dx2) this._dx2 = c + 1;
  }
}

// endColumn (bits 0-19) | damageX1 (bits 20-35) | damageX2 (bits 36+), as a double.
// PACK-END (rule): the end column saturates into the 20 bits the caller reads as
//   `m % 1048576`, 0 below and 1048575 above.
function _csPack(endCol, x1, x2) {
  const e = endCol < 0 ? 0 : (endCol > 0xfffff ? 0xfffff : endCol);
  return e + (x1 * 1048576) + (x2 * 68719476736);
}

const Bun = {
  version: process.versions.bun || '1.4.0',
  revision: '0000000000000000000000000000000000000000',
  main: require.main && require.main.filename,
  env: process.env,
  argv: process.argv,
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,

  stripANSI, stringWidth, wrapAnsi, sliceAnsi,
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

  // Bun.sleepSync(ms) — NEW IN 2.1.278 and ON THE TTY PATH, which is why it is
  // implemented rather than accepted-missing. Upstream's owed-reply drain reads
  // /dev/tty non-blocking in a bounded loop and pauses 2ms between empty reads:
  //
  //     for (let R = 0; R < 64; R++) { ... if (A > 0) {...; continue}
  //                                    if (A < 0 || M <= 0 || now >= deadline) break;
  //                                    Bun.sleepSync(2) }
  //
  // The whole block is inside `try{...}catch{}`, so a missing sleepSync does not
  // crash — it ABANDONS the drain on the first empty read, and the terminal
  // replies nobody consumed then land in the user's shell after quaude exits.
  // Silent, cosmetic, and exactly the kind of "guarded, therefore fine" reasoning
  // that let Bun.ant's accepted-missing note go stale (see inspect-claude-bundle).
  //
  // ONE implementation, two engines, no platform branch: Atomics.wait on a
  // SharedArrayBuffer is a real blocking sleep and is what Node gives us; under
  // tjs it is unavailable on the main thread ([[tjs-atomics-cant-block-main]] —
  // it THROWS rather than blocking), so the catch falls through to a bounded
  // spin. Spinning is acceptable here and only here because the caller's own
  // deadline caps the total at a quarter of a second.
  sleepSync(ms) {
    const want = Number(ms);
    const dur = Number.isFinite(want) && want > 0 ? want : 0;
    if (dur === 0) return;
    const end = Date.now() + dur;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, dur);
      return;
    } catch (_) { /* tjs main thread: Atomics.wait throws — spin instead */ }
    while (Date.now() < end) { /* bounded by the caller's own deadline */ }
  },

  // Bun.unsafe — an EMPTY NAMESPACE, deliberately, and it has to EXIST.
  //
  // NEW BETWEEN 2.1.257 AND 2.1.278 (measured: zero `setJITPolicy` strings in the
  // .251 and .257 provider binaries, four call sites in .278). Upstream writes it
  //
  //     if (typeof Bun < "u") Bun.unsafe.setJITPolicy?.(1)
  //
  // at four points on the STARTUP path — once on a 10s unref'd timer, three times as
  // the CLI message loop / agents list / turn host come up. Note where the `?.` is:
  // on the METHOD, not on the namespace. Upstream treats `Bun.unsafe` as something
  // that always exists wherever `Bun` does, so under this shim (which defines a Bun
  // global, and must keep doing so) the deref threw a bare TypeError and the session
  // died with "An internal error ended the session (cannot read property
  // 'setJITPolicy' of undefined)". That is the Bun.SQL trap again: defining Bun at
  // all is what puts us inside a branch written for real Bun.
  //
  // EMPTY rather than `{ setJITPolicy(){} }`, per the Bun.ant rule below: upstream
  // already optional-chained the method, so absence is a shape it handles, and a
  // stub would advertise a JIT-policy control we cannot honor. There is no JIT to
  // police — quaude is QuickJS (interpreter + bytecode, no tiering), and naude's V8
  // has no such API either — so the no-op the `?.` produces is not a degradation,
  // it IS the correct behavior on both engines. Nothing else in the 2.1.278 bundle
  // reads `Bun.unsafe` (grepped the carved graph: 4 hits, all setJITPolicy).
  //
  // Real Bun's `unsafe` also carries arrayBufferToString / segfault /
  // gcAggressionLevel / mimallocDump. None are referenced by the bundle; add them
  // only against a measured call site, and only if the call site cannot tolerate
  // absence the way this one can.
  unsafe: {},

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
  // Bun.ant — EXACTLY ONE MEMBER, and the rest must STAY absent. Anthropic's own
  // private Bun namespace, and the ONE place in this shim where "provide it" and
  // "leave it absent" are both right, member by member:
  //
  //   CellSegmenter                    PROVIDED (see the implementation above)
  //   getPeerUid(fd) / getPeerPid(fd)  ABSENT — SO_PEERCRED / LOCAL_PEERCRED on a UDS
  //   setDumpable(bool)                ABSENT — Linux prctl(PR_SET_DUMPABLE, 0)
  //   memoryPressureLevel()            ABSENT — macOS memory-pressure level
  //   waitForUrlEvent()                ABSENT — macOS claude-cli:// deep-link handoff
  //
  // DO NOT ADD THE OTHERS, and do not reach for a convenient `{ ...ant, ... }`.
  // Upstream gates a whole capability on
  // `typeof Bun.ant?.getPeerPid === "function"`, so a stub — even a throwing
  // one — flips that probe TRUE and makes upstream advertise a peer-credential
  // capability we cannot honor. That is the Bun.SQL trap elsewhere in this file
  // running in reverse: there, defining a Bun global defeated a guard that
  // wanted Bun absent; here, defining Bun.ant.getPeerPid would defeat a probe
  // that is currently getting the RIGHT answer. Adding CellSegmenter beside it
  // does NOT flip that probe — `Bun.ant?.getPeerPid` is still undefined — which
  // is the whole reason this namespace can be introduced at all.
  // test/bun-shim-ant-gap.test.cjs asserts the membership EXACTLY, so adding a
  // second member is a test failure and not a quiet capability change.
  //
  // WHY THE OTHERS ARE NOT IMPLEMENTED (checked, not assumed):
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
  // WHAT A USER OBSERVES, per absent call site, all with upstream's own fallback:
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
  // Recorded in test/shim-surface/golden.json, which no longer lists Bun.ant as
  // a layer-1 gap because the property now exists.
  ant: { CellSegmenter: _CellSegmenter },
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
// bun-shim needs no sibling beyond unicode-text.cjs, the one companion every
// packaging carries beside it (test/shim-companions.test.cjs); node:sqlite is a
// builtin, not a sibling file. Fail-loud if no SQLite backend exists. Tests:
// test/bun-sqlite.test.cjs.
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
module.exports.parseShadow = parseShadow;               // for test/build-gates/shadow-writer-gates.test.cjs
module.exports.SHADOW_ARG_SPELLINGS = SHADOW_ARG_SPELLINGS; //   (0b: the gate must use this, not restate it)
module.exports._wsArgs = _wsArgs;
module.exports.warnAppletSkew = warnAppletSkew;
module.exports.awaitSkewProbe = awaitSkewProbe;
module.exports._markSnapshotProbed = _markSnapshotProbed;   // for test/extract-hooks.test.cjs
module.exports.CLODE_SHADOWS = CLODE_SHADOWS;
module.exports.RG_PATH = RG_PATH;               // quaude's own rg path, stated once above (test/bun-shim-which.test.cjs, rg-differential)
module.exports._whichLeaves = _whichLeaves;     // exported for test/bun-shim-which.test.cjs
module.exports._exeIsPathed = _exeIsPathed;     //   (the win32 seams, driven from a Mac)
globalThis.Bun = globalThis.Bun || module.exports;   // ensure global even if required directly

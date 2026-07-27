#!/usr/bin/env node
'use strict';
// extract-claude-js.cjs  <claude-native-binary>  <out-cli.cjs>
//
// JS port of libexec/extract-claude-js (the Python oracle). Produces
// byte-identical output. See that file for the full design rationale; this is a
// faithful 1:1 translation, function-for-function, using the latin1 round-trip
// (1 char == 1 byte) so byte regexes become latin1-string regexes.

const fs = require('node:fs');
const { carveBlocks } = require('./bundle-carve.cjs');

// __doc__ equivalent: reproduced verbatim from the Python module docstring so the
// usage/error path prints identical text.
const DOC = `
extract-claude-js  <claude-native-binary>  <out-cli.cjs>

Pull the Claude Code JS bundle out of a Bun \`--compile\` standalone binary so it
can run under plain Node. Version-independent: it does NOT depend on hardcoded
offsets or the (private) Bun version — it searches for the Bun CJS entry marker
and carves the bundle up to the next NUL.

What it does:
  1. Find every Bun CJS module block:  \`// @bun ... @bun-cjs\n(function(exports,
     require, module, __filename, __dirname) {  ...body...  })\`  terminated by a
     NUL byte (minified JS has no raw NULs).
  2. Pick the block named entrypoints/cli.js — refuses to guess if not found.
  3. Strip the marker + CJS wrapper, leaving the bare module body.
  4. Rewrite \`import.meta\` (illegal in Node CJS) to a CJS-safe shim object.
  5. Prepend a prelude that installs the Bun-global shim and __import_meta.
  6. Verify the output before writing (rejects bad carves, removes partial output).

The result is \`require()\`-able / runnable by Node >=18.
`;

// Tokens that must appear in any legitimate Claude Code CLI bundle.
const SENTINELS = ['commander', '@anthropic-ai/claude-code'];

// The CLI entrypoint is ~17 MB; anything smaller is a bad carve.
// Only enforced by contentChecks()/main() — not by verify() — so unit tests on
// synthetic data still work.
const MIN_OUTPUT_BYTES = 1000000;

// sys.exit(str) equivalent: write the message + newline to stderr, exit 1.
function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

// Select the cli.js entry block by name. A bundle with no entrypoints/cli.js
// block means the format changed — refuse to guess, so a bad carve never ships.
function pickEntry(blocks) {
  // Throws (rather than process.exit) so an in-process caller (clode-extract) can
  // catch a format change and fail loudly WITHOUT tearing down the launcher. main()
  // re-adds the 'error: ' prefix via die(), so the CLI's stderr + exit-1 is unchanged.
  if (!blocks.length) {
    throw new Error('no Bun @bun-cjs entry marker found — format may have changed');
  }
  const named = blocks.find((b) => (b.name || '').endsWith('entrypoints/cli.js'));
  if (named === undefined) {
    const bySize = blocks.reduce((a, b) => (b.size > a.size ? b : a));
    throw new Error('no block named entrypoints/cli.js; bundle format may have changed '
      + `(largest candidate was ${bySize.size} bytes). Refusing to guess.`);
  }
  return named;
}

const PRELUDE =
`// ---- mavericks node-host prelude (auto-generated) ----
globalThis.Bun = globalThis.Bun || require(__dirname + '/bun-shim.cjs');
const __import_meta = {
  url: require('url').pathToFileURL(__filename).href,
  dirname: __dirname,
  filename: __filename,
  env: process.env,
  main: require.main === module,
  resolve: (s) => require('url').pathToFileURL(require.resolve(s)).href,
};
// clode's in-app autoupdater is patched (below) to CHECK for a newer upstream
// Claude Code and notify — never install/rebuild (a built target may run where
// no clode exists). This resolves the three-state check and returns the bundle's
// {wasUpdated,latestVersion,lockFailed} shape with wasUpdated ALWAYS false, plus
// a __clodeState tag the notice patch reads.
globalThis.__clodeCheckUpdate = function (current) {
  var chk = require(__dirname + '/target-update-check.cjs');
  var semverOrder = (globalThis.Bun && globalThis.Bun.semver && globalThis.Bun.semver.order)
    ? globalThis.Bun.semver.order : function (a, b) { return a === b ? 0 : (a > b ? 1 : -1); };
  return chk.checkUpdate({ current: current, env: process.env, semverOrder: semverOrder })
    .then(function (r) {
      return { wasUpdated: false,
        latestVersion: r.state === 'newer' ? r.latest : null,
        lockFailed: false, __clodeState: r.state };
    })
    .catch(function () { return { wasUpdated: false, latestVersion: null, lockFailed: false, __clodeState: 'unknown' }; });
};
// ------------------------------------------------------
`;

// --- doctor installation-warnings contribution -------------------------------
// Contribute clode's applet-skew findings as NATIVE Claude "Installation warnings"
// data, rather than grafting our own /doctor section. The doctor diagnostics
// builder returns an object `{installationType:…,warnings:L,packageManager:…,…}`
// where `L` is the warnings array the "Installation warnings" section renders (each
// {issue,fix} -> an `issue` line + a `fix` line). We splice a contribution that
// pushes one {issue,fix} per skew finding onto L, just before that return.
//
// Anchor: `return{installationType:` is a UNIQUE, unminified marker (object keys are
// not minified); the bounded `.{0,400}?` skips the intervening fields (incl. the
// autoUpdates arrow's own `return`) to capture the warnings var from `,warnings:<id>,
// packageManager:`. Same fail-loud contract as the other doctor patches: inject only
// on an exactly-once match; never brick /doctor (skew still warns on stderr).
//
// The remedy (`fix`) is the applet-specific one bun-shim records on each finding
// (`s.fix`), so the /doctor advice matches the stderr advice exactly (e.g. bfs's
// "install bfs >= 3.3 built with Oniguruma ..."). A generic CLODE_<APPLET> hint is
// the fallback if an older shim recorded a finding without `s.fix`.
//
// The 400 cap is ~2x the real-bundle gap (~210 chars between installationType: and
// ,warnings:); a future Claude that grows past it fails the exactly-once match
// (caught by inspect-claude-bundle --strict), never silently mis-injects.
const INSTALL_WARNINGS =
  /return\{installationType:.{0,400}?,warnings:(?<arr>[A-Za-z0-9_$]{1,6}),packageManager:/gs;

// JS spliced before the diagnostics return, two steps in order:
//   1. EAGER ensure: await the snapshot bridge (globalThis.__clodeEnsureSnapshot,
//      exposed by patchSnapshotBridge below) so snapshot generation — which fires
//      bun-shim's skew probe — completes BEFORE the findings are read. This is what
//      makes the skew visible on the FIRST open of every warnings-rendering
//      surface (the /doctor screen on <=2.1.204; `claude doctor` terminal and the
//      /status warnings list on 2.1.205+), not only after the first shell command.
//      Guarded + try/caught: a missing bridge or a failed generation degrades to
//      today's lazy behavior, never breaks diagnostics. Legal `await`: the splice
//      point is the top level of the (always-async) diagnostics builder — the
//      anchor's `return{...}` sits directly inside `async function ...({probeKeychain...`
//      (verified on 2.1.203/204/205; the functional tests in
//      test/extract-hooks.test.cjs run the spliced builder for real).
//   2. Defensively push each clode skew finding onto the warnings array `arr`.
//      Safe by construction: bun-shim always records `name`, `applet`, and `why`
//      as strings (CLODE_SHADOWS), so the string operations below are always
//      valid. A no-op when there is no skew.
// The forEach callback param is deliberately UN-MINIFIABLE (>6 chars): since
// 2.1.203 the warnings array minifies to `s`, and a 1-6-char param (the old code
// used `s`) can shadow it — `s.push` then hits the finding object and throws.
function _skewContribution(arr) {
  return (
    'if(globalThis.__clodeEnsureSnapshot)try{await globalThis.__clodeEnsureSnapshot()}catch(__clodeErr){};'
    + 'globalThis.__clodeDoctor&&globalThis.__clodeDoctor.appletSkew&&'
    + 'globalThis.__clodeDoctor.appletSkew.forEach(function(__clodeSkw){' + arr + '.push({'
    + 'issue:"host "+__clodeSkw.applet+" rejects flags clode\\u2019s bundled /"+__clodeSkw.name+" uses \\u2014 "+__clodeSkw.why,'
    + 'fix:__clodeSkw.fix||("set CLODE_"+__clodeSkw.applet.toUpperCase()+" to a compatible "+__clodeSkw.applet)'
    + '})});'
  );
}

// Splice the skew contribution before the doctor diagnostics return. Returns
// [newBody, applied]; applied is false (body unchanged) unless the anchor matches
// exactly once.
function patchDoctorWarnings(body) {
  const m = [...body.matchAll(INSTALL_WARNINGS)];
  if (m.length !== 1) return [body, false];
  const inject = _skewContribution(m[0].groups.arr);
  const cut = m[0].index;
  return [body.slice(0, cut) + inject + body.slice(cut), true];
}

// --- eager-snapshot bridge ----------------------------------------------------
// Make the applet-skew findings show on the FIRST open of a warnings surface, not
// only after a shell command. The skew probe (bun-shim's warnAppletSkew) runs when
// Claude generates its shell snapshot, which Claude does lazily on first Bash use —
// so a fresh /doctor (or /status, or `claude doctor`) is empty. We can't probe
// eagerly without the snapshot: the embedded flags are built dynamically
// (ARGV0=${...} "$_cc_bin" -S dfs ...), so they only exist once the snapshot script
// is generated.
//
// One anchor, best-effort + fail-loud: SNAPSHOT_GEN — the no-arg generator
// `async function G(){let h=await S();return{provider:await I(h)}}`. Expose it as
// globalThis.__clodeEnsureSnapshot, set when its (eagerly-initialized) module body
// runs. The CONSUMER of the bridge is the _skewContribution splice above: the
// diagnostics builder awaits the bridge before reading findings, so generation
// (and the probe) completes before any surface renders warnings.
//
// HISTORY: through 2.1.204 a second anchor (DOCTOR_LOAD) chained the ensure-step
// onto the /doctor command's `load:()=>Promise.resolve().then(...)`. Upstream
// 2.1.205 reworked /doctor into a prompt-driven agent command
// (`{name:"doctor",aliases:["checkup"],...,async getPromptForCommand...}`) with no
// load site, killing that anchor — the SECOND upstream rework in this area. Riding
// the diagnostics builder instead (a) needs NO doctor-command-shaped anchor at
// all, and (b) covers every surface that renders the builder's warnings, per
// version: the /doctor screen (<=2.1.204), `claude doctor` terminal + the /status
// warnings list (2.1.205+). The 2.1.205 /doctor agent itself gathers install data
// by running its own shell checks and never reads the builder, so it cannot render
// clode's findings on any design; /status and `claude doctor` carry them instead
// (and the stderr warning at snapshot time remains the always-on source of truth).
//
// If the bridge is unset when a surface opens (generator module not yet
// initialized), the builder's ensure-step is a no-op and that surface falls back
// to lazy behavior — no regression.
//
// Short minified-id bounds ({1,6}) keep the anchor a tight linear scan over
// minified names without matching across unrelated code.
const SNAPSHOT_GEN =
  /async function (?<gen>[A-Za-z0-9_$]{1,6})\(\)\{let (?<h>[A-Za-z0-9_$]{1,6})=await [A-Za-z0-9_$]{1,6}\(\);return\{provider:await [A-Za-z0-9_$]{1,6}\(\k<h>\)\}\}/g;

// Expose the snapshot generator as globalThis.__clodeEnsureSnapshot (the bridge
// the _skewContribution splice awaits). Returns [body, applied]; applied is false
// (body unchanged) unless the anchor matches exactly once.
function patchSnapshotBridge(body) {
  const gens = [...body.matchAll(SNAPSHOT_GEN)];
  if (gens.length !== 1) return [body, false];
  const g = gens[0];
  const gEnd = g.index + g[0].length;
  const expose = 'globalThis.__clodeEnsureSnapshot=' + g.groups.gen + ';';
  return [body.slice(0, gEnd) + expose + body.slice(gEnd), true];
}

// --- Remote Control honest gate-off under quaude -----------------------------
// Remote Control opens a `ws`/WebSocket bridge. Under tjs the ws stack can't load
// (the tjs runtime lacks the WebSocket transport `ws` module). An earlier
// node:stream .prototype TypeError is now fixed at the root, leaving `ws`
// absence as the only reason this gate persists). The bundle already has a graceful path: cBo() returns
// a reason string, Vei() renders it and never enables the bridge. We make cBo()
// return a quaude-specific reason when globalThis.__clodeWsUnavailable is set
// (bun-shim.cjs), so the crashing module never loads and the session survives.
//
// Anchor: the availability gate itself (formerly cBo, an inline
// `if(<fn>())return"...api.anthropic.com."`). Upstream (2.1.207-era) hoisted the
// api.anthropic.com reason into a `var mbr=...` returned by a helper, so that
// inline literal is gone; the gate is now a minified `async function X(){ ... }`
// that returns null when Remote Control IS available or a reason string when not.
// We pin it by its stable opening — `if(..())return null` (available), then the
// first-party helper return, then the STABLE English "not available inside a cloud
// session" literal — with minified-id wildcards (same style as the autoupdater
// anchor). `pre` captures `async function X(){`; we splice the gate-off as the
// function's FIRST statement so __clodeWsUnavailable wins before ANY available
// (`return null`) path is reached. Same exactly-once + fail-loud contract as the
// other patches; the strict gate lives in inspect-claude-bundle.cjs.
const RC_NOTICE =
  'Remote Control isn\\u2019t available in quaude yet \\u2014 its engine has no WebSocket transport.';
const REMOTE_CONTROL_GATE_ANCHOR =
  /(?<pre>async function [A-Za-z0-9_$]{1,8}\(\)\{)if\([A-Za-z0-9_$]{1,8}\(\)\)return null;if\(!?[A-Za-z0-9_$]{1,8}\(\)\)return [A-Za-z0-9_$]{1,8}\(\);if\([A-Za-z0-9_$]{1,8}\(\)\)return"Remote Control is not available inside a cloud session\."/g;
// Old shape (<=2.1.218): the api.anthropic.com reason was returned inline behind
// its own `if(<fn>())` guard; splice in front of that guard. Kept so clode still
// gates Remote Control on the last old-shape releases (same multi-shape support
// as patchDoctorWarnings's 2.1.179/2.1.205 anchors).
const REMOTE_CONTROL_INLINE_ANCHOR =
  /if\(!?[A-Za-z0-9_$]{1,8}\(\)\)return"Remote Control is only available when using Claude via api\.anthropic\.com\."/g;

function patchRemoteControlUnavailable(body) {
  const inject = 'if(globalThis.__clodeWsUnavailable)return"' + RC_NOTICE + '";';
  const gate = [...body.matchAll(REMOTE_CONTROL_GATE_ANCHOR)];
  if (gate.length === 1) {
    const cut = gate[0].index + gate[0].groups.pre.length;   // after `async function X(){`
    return [body.slice(0, cut) + inject + body.slice(cut), true];
  }
  const inline = [...body.matchAll(REMOTE_CONTROL_INLINE_ANCHOR)];
  if (inline.length === 1) {
    const cut = inline[0].index;                             // before the reason guard
    return [body.slice(0, cut) + inject + body.slice(cut), true];
  }
  return [body, false];
}

// --- pkg-manager autoupdater NOTIFY (no install, no CLODE_SELF) ---------------
// Claude Code's in-TUI autoupdater (the pkg-manager path) spawns an npm/install
// command `cmd` (destructured as `let[a,...b]=cmd`) then treats `code===0` as
// "Update installed · Restart to apply". A built target has no npm-managed install
// to update, so we must NOT run an installer AND must not falsely claim an update
// was installed. The native path (above) is the PRIMARY notify surface — it binds
// latestVersion into the notice. Here (defensive/secondary, since a built target's
// detected install-type usually routes to the native path) we, spliced right after
// the auto_updater_start telemetry and before the destructure:
//   1. fire globalThis.__clodeCheckUpdate(...) for its latestVersion side-effect
//      (the Task 4 notice reads it), and
//   2. reassign `cmd` to a non-installing no-op argv (["false"]) so the spawn
//      cannot install anything AND exits non-zero — the `code===0` false-success
//      branch is NOT taken (no bogus "Restart to apply"); the else branch is a
//      debug log, not a user-facing claim.
// NEVER references CLODE_SELF. NOTE: unlike the native path, this site binds no
// nearby VERSION literal, so the check receives globalThis.__clodeCurrentVersion
// (may be unset -> ""); checkUpdate degrades to best-effort. Wiring a robust
// current-version here (module-global version-constant discovery) and pinning the
// exact portable no-op argv are Task 6 characterization items — the native path
// carries the authoritative notice meanwhile. Same identifier bounding rationale as
// the doctor anchors (short minified ids, linear scan).
//
// Three destructure shapes, alternated after `=<cmd>`:
//   - comma form  `let[a,...b]=cmd,c=await f(`            — PROVEN real <=2.1.202 (2.1.179)
//   - split form  `let[a,...b]=cmd;let x=a;let y=b;let z=await f(x,y,` — PROVEN real
//     2.1.203-2.1.205 (upstream unchained the let; backrefs \k<a>/\k<rest> pin the
//     aliases to the destructured parts so the scan can't drift to unrelated code).
//   - direct form `let[a,...b]=cmd;let z=await f(a,b,`    — PROVEN real 2.1.210
//     (2.1.207 still emits the split form; upstream dropped the intermediate
//     aliases and now passes the destructured parts straight to the call). The
//     backrefs move to the CALL ARGS (\k<a>,\k<rest>), which pins this shape at
//     least as tightly as the split form's aliases did.
// Every shape has <cmd> as a `let`-declared local, and the override splices BEFORE
// the destructure, so all three read clode's argv identically — the alternation is
// a shape CHECK, not part of the rewrite.
const AUTOUPDATER_SPAWN =
  /(?<pre>tengu_pkg_manager_auto_updater_start",[A-Za-z0-9_$]{1,6}\);)let\[(?<a>[A-Za-z0-9_$]{1,6}),\.\.\.(?<rest>[A-Za-z0-9_$]{1,6})\]=(?<cmd>[A-Za-z0-9_$]{1,6})(?:,[A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=\k<a>;let [A-Za-z0-9_$]{1,6}=\k<rest>;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(\k<a>,\k<rest>,)/g;

// Neutralize the pkg-manager autoupdater to notify-only: fire __clodeCheckUpdate
// (side-effect: latestVersion for the notice) and reassign the spawn argv to a
// non-installing, non-zero-exit no-op so nothing installs and no false success is
// claimed. Never spawns CLODE_SELF. Returns [newBody, applied]; applied false
// unless exactly one match (fail-loud).
function patchAutoupdater(body) {
  const m = [...body.matchAll(AUTOUPDATER_SPAWN)];
  if (m.length !== 1) return [body, false];
  const cmd = m[0].groups.cmd;
  const pre = m[0].groups.pre;
  const override = cmd
    + '=(globalThis.__clodeCheckUpdate&&globalThis.__clodeCheckUpdate('
    + 'globalThis.__clodeCurrentVersion||""),["false"]);';
  const cut = m[0].index + pre.length;
  return [body.slice(0, cut) + override + body.slice(cut), true];
}

// --- native autoupdater NOTIFY (no install, no CLODE_SELF) --------------------
// Claude Code's in-TUI NATIVE autoupdater installs in-process: after the
// `tengu_native_auto_updater_start` telemetry it does
// `try{let S=await <fn>(<arg>),w={...,VERSION:"x.y.z",...},…` where <fn> returns
// {wasUpdated,latestVersion,lockFailed} and the NEXT declarator binds the running
// bundle's metadata object (whose VERSION field is the current version). A built
// target runs extracted JS where no in-place native install (and no clode) exists,
// so we NEVER install. Instead we replace `await <fn>(<arg>)` with
// `await globalThis.__clodeCheckUpdate("<version>")` (installed by the PRELUDE):
// it resolves the three-state upstream check and returns a {wasUpdated:false,
// latestVersion, lockFailed:false, __clodeState} shape, so the bundle never renders
// "Restart to apply" and the Task 4 notice patch reads latestVersion from it.
//
// How the CURRENT version reaches the check: the metadata object bound as the very
// next declarator carries `VERSION:"x.y.z"` as a STRING LITERAL. We read that
// literal via a (non-consuming) lookahead and pass it directly as the argument, so
// the compared `current` is the real running version WITHOUT a global that nothing
// reliably sets and WITHOUT reordering the declarators (the object binding is left
// verbatim). The `.{0,300}?` bound skips the fields before VERSION (~180 chars real)
// non-greedily so it can't drift to an unrelated VERSION; growth past it fails the
// exactly-once match (fail-loud skip, caught by inspect --strict) rather than
// mis-injecting. Anchor VERIFIED exactly-once (correct version captured) on real
// 2.1.204 / 2.1.210 / 2.1.218 and the 2.1.179 fixture.
const NATIVE_AUTOUPDATER =
  /(?<pre>tengu_native_auto_updater_start",(?:\{\}|[A-Za-z0-9_$]{1,6})\);try\{let [A-Za-z0-9_$]{1,6}=await )(?<call>[A-Za-z0-9_$]{1,6}\([A-Za-z0-9_$]{1,6}\)),(?=[A-Za-z0-9_$]{1,6}=\{.{0,300}?VERSION:"(?<ver>[0-9][^"]{0,20})")/gs;

// Redirect the in-TUI NATIVE autoupdater to the notify-only check with the real
// running version. Replaces `await <fn>(<arg>)` with
// `await globalThis.__clodeCheckUpdate("<version>")`; never installs, never spawns
// CLODE_SELF. Returns [newBody, applied]; applied false unless exactly one match
// (fail-loud).
function patchNativeAutoupdater(body) {
  const m = [...body.matchAll(NATIVE_AUTOUPDATER)];
  if (m.length !== 1) return [body, false];
  const pre = m[0].groups.pre;
  const ver = m[0].groups.ver;   // string literal, no quotes/backslashes (regex-bounded)
  const override = pre + 'globalThis.__clodeCheckUpdate("' + ver + '"),';
  return [body.slice(0, m[0].index) + override + body.slice(m[0].index + m[0][0].length), true];
}

// Rewrite *body* to be Node CJS-compatible and prepend the prelude. Replaces all
// `import.meta` references with `__import_meta` (defined by the prelude), then
// contributes the clode applet-skew findings to the native installation-warnings
// data (refreshing the skew probe eagerly via the snapshot bridge), exposes that
// bridge, and redirects both autoupdaters. Replacing inside strings is harmless.
function transform(body) {
  body = body.replace(/\bimport\.meta\b/g, '__import_meta');
  let applied;
  [body, applied] = patchDoctorWarnings(body);
  if (!applied) {
    process.stderr.write(
      'clode: /doctor applet-skew hook NOT applied — installation-warnings anchor '
      + '(return{installationType:...,warnings:...}) not found exactly once (Claude '
      + 'version drift?). Skew still warns on stderr at startup; run '
      + 'inspect-claude-bundle --strict to confirm the surface.\n');
  }
  let bridge;
  [body, bridge] = patchSnapshotBridge(body);
  if (!bridge) {
    process.stderr.write(
      'clode: eager-snapshot bridge NOT applied — snapshot-generator anchor not '
      + 'found exactly once (Claude version drift?). Applet-skew findings still appear '
      + 'after the first shell command; run inspect-claude-bundle --strict.\n');
  }
  let au;
  [body, au] = patchAutoupdater(body);
  if (!au) {
    process.stderr.write(
      'clode: in-TUI autoupdater hook NOT applied — pkg-manager apply anchor not found '
      + 'exactly once (Claude version drift?). `clode fetch` still works; '
      + 'run inspect-claude-bundle --strict.\n');
  }
  let nau;
  [body, nau] = patchNativeAutoupdater(body);
  if (!nau) {
    process.stderr.write(
      'clode: in-TUI NATIVE autoupdater hook NOT applied — native apply anchor '
      + 'not found exactly once (Claude version drift?). `clode fetch` still '
      + 'works; run inspect-claude-bundle --strict.\n');
  }
  let rc;
  [body, rc] = patchRemoteControlUnavailable(body);
  if (!rc) {
    process.stderr.write(
      'clode: Remote Control gate-off hook NOT applied — cBo api.anthropic.com '
      + 'reason anchor not found exactly once (Claude version drift?). Remote Control '
      + 'may silently no-op under quaude; run inspect-claude-bundle --strict.\n');
  }
  return PRELUDE + body + '\n';
}

function verify(outText) {
  const problems = [];
  if (outText.includes('\x00')) {
    problems.push('output contains NUL bytes (bad carve boundary)');
  }
  if (outText.includes('import.meta')) {
    problems.push('output still contains import.meta (rewrite missed a form)');
  }
  return problems;
}

function contentChecks(outText) {
  const problems = [];
  if (outText.length < MIN_OUTPUT_BYTES) {
    problems.push(`output too small: ${outText.length} bytes (< ${MIN_OUTPUT_BYTES} size floor)`);
  }
  if (!SENTINELS.some((s) => outText.includes(s))) {
    problems.push('no expected sentinel token found (not the cli bundle?)');
  }
  return problems;
}

// Extract the CLI bundle from *binpath* and write the Node-CJS-runnable cli.cjs to
// *out*. The reusable core of main(): read latin1 -> carve -> pickEntry -> transform
// -> write Buffer(latin1) -> verify + contentChecks. Removes a bad partial output and
// THROWS on any verification/content problem (loud failure the in-process caller can
// catch), rather than calling process.exit — so it is safe to require() and call from
// clode-extract without tearing the whole launcher down. Returns { name, bytes } for
// the caller's progress line. Byte-for-byte identical to what the CLI wrote before.
function extractToFile(binpath, out) {
  const data = fs.readFileSync(binpath, 'latin1');
  const entry = pickEntry(carveBlocks(data));
  const text = transform(entry.body);
  fs.writeFileSync(out, Buffer.from(text, 'latin1'));
  const problems = verify(text).concat(contentChecks(text));
  if (problems.length) {
    try { fs.rmSync(out); } catch (e) { /* ignore */ }
    throw new Error('extraction failed verification:\n  - ' + problems.join('\n  - '));
  }
  return { name: entry.name, bytes: text.length };
}

function main(argv) {
  const pos = argv.filter((a) => !a.startsWith('-'));
  if (pos.length !== 2) {
    die(DOC);
  }
  const [binpath, out] = pos;
  let res;
  try {
    res = extractToFile(binpath, out);
  } catch (e) {
    // Preserve the CLI's exact stderr + exit-1 contract (die's 'error: ' prefix +
    // the verification detail extractToFile carries in its message).
    die('error: ' + e.message);
  }
  process.stderr.write(`entry=${res.name || '<unknown>'}\nwrote ${out} (${res.bytes} bytes)\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  pickEntry,
  patchDoctorWarnings,
  patchSnapshotBridge,
  patchAutoupdater,
  patchNativeAutoupdater,
  patchRemoteControlUnavailable,
  transform,
  verify,
  contentChecks,
  extractToFile,
  main,
  PRELUDE,
};

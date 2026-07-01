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
// clode's native-autoupdater redirect calls this (when CLODE_SELF is set): spawn
// clode's own host-agnostic fetch instead of upstream's in-process native install,
// then resolve a success-shaped result so the bundle renders "Restart to apply".
globalThis.__clodeNativeUpdate = function () {
  return new Promise(function (resolve) {
    var child = require('child_process').spawn(
      process.env.CLODE_SELF, ['--clode-internal-update'], { stdio: 'inherit' });
    // Report success only when clode's update actually succeeded (exit 0), so a
    // failed fetch doesn't drive the bundle's "Restart to apply" path onto an
    // unchanged version. \`--clode-internal-update\` propagates clode_update's status.
    child.on('exit', function (code) {
      resolve({ wasUpdated: code === 0, latestVersion: null, lockFailed: false }); });
    child.on('error', function () {
      resolve({ wasUpdated: false, latestVersion: null, lockFailed: false }); });
  });
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

// JS spliced before the diagnostics return: defensively push each clode skew
// finding onto the warnings array `arr`. Safe by construction: cannot throw on
// well-formed findings — bun-shim always records `name`, `applet`, and `why` as
// strings (CLODE_SHADOWS), so the string operations below are always valid. A
// no-op when there is no skew.
function _skewContribution(arr) {
  return (
    'globalThis.__clodeDoctor&&globalThis.__clodeDoctor.appletSkew&&'
    + 'globalThis.__clodeDoctor.appletSkew.forEach(function(s){' + arr + '.push({'
    + 'issue:"host "+s.applet+" rejects flags clode\\u2019s bundled /"+s.name+" uses \\u2014 "+s.why,'
    + 'fix:s.fix||("set CLODE_"+s.applet.toUpperCase()+" to a compatible "+s.applet)'
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

// --- doctor eager-snapshot wiring --------------------------------------------
// Make /doctor show the applet-skew on the FIRST open, not only after a shell
// command. The skew probe (bun-shim's warnAppletSkew) runs when Claude generates
// its shell snapshot, which Claude does lazily on first Bash use — so a fresh
// /doctor is empty. We can't probe eagerly without the snapshot: the embedded flags
// are built dynamically (ARGV0=${...} "$_cc_bin" -S dfs ...), so they only exist
// once the snapshot script is generated. The fix: have /doctor trigger snapshot
// generation (which fires our probe) and await it before rendering.
//
// Two anchors, both best-effort + fail-loud (never brick /doctor):
//   1. SNAPSHOT_GEN — the no-arg generator `async function G(){let h=await S();
//      return{provider:await I(h)}}`. Expose it as globalThis.__clodeEnsureSnapshot,
//      set when its (eagerly-initialized) module body runs.
//   2. DOCTOR_LOAD — the /doctor command's `load:()=>Promise.resolve().then(...)`.
//      Chain an ensure-step before the original so generation completes (and the
//      probe populates __clodeDoctor) before the screen renders.
// If the bridge is unset when /doctor opens (generator module not yet initialized),
// the ensure-step is a no-op and /doctor falls back to today's lazy behavior — no
// regression. We apply BOTH or NEITHER (a half-wired patch is pointless).
//
// Short minified-id bounds ({1,6}/{1,8}) keep each anchor a tight linear scan over
// minified names without matching across unrelated code.
const SNAPSHOT_GEN =
  /async function (?<gen>[A-Za-z0-9_$]{1,6})\(\)\{let (?<h>[A-Za-z0-9_$]{1,6})=await [A-Za-z0-9_$]{1,6}\(\);return\{provider:await [A-Za-z0-9_$]{1,6}\(\k<h>\)\}\}/g;
const DOCTOR_LOAD =
  /(?<prefix>name:"doctor".{0,240}?)load:\(\)=>Promise\.resolve\(\)\.then\((?<cb>\(\) => \([A-Za-z0-9_$]{1,8}\(\),[A-Za-z0-9_$]{1,8}\))\)/gs;
// Defensive ensure-step: never throws (a sync throw becomes a rejection),
// swallows errors so a snapshot failure can never brick /doctor; no-op when the
// bridge isn't set yet.
const _DOCTOR_ENSURE =
  '()=>{var g=globalThis.__clodeEnsureSnapshot;'
  + 'return g?Promise.resolve().then(g).catch(function(){}):void 0}';

// Wire /doctor to generate the shell snapshot (firing the skew probe) before it
// renders, so the applet-skew section shows on first open. Returns [body, applied];
// applied is false (body unchanged) unless BOTH anchors match exactly once.
function patchDoctorEager(body) {
  const gens = [...body.matchAll(SNAPSHOT_GEN)];
  const loads = [...body.matchAll(DOCTOR_LOAD)];
  if (gens.length !== 1 || loads.length !== 1) return [body, false];
  const g = gens[0];
  const L = loads[0];
  const newLoad = 'load:()=>Promise.resolve().then(' + _DOCTOR_ENSURE
    + ').then(' + L.groups.cb + ')';
  // Splice the later offset first so the earlier splice's offsets stay valid.
  const gEnd = g.index + g[0].length;
  const expose = 'globalThis.__clodeEnsureSnapshot=' + g.groups.gen + ';';
  const edits = [
    [gEnd, gEnd, expose],
    [L.index, L.index + L[0].length, L.groups.prefix + newLoad],
  ].sort((a, b) => b[0] - a[0]);
  for (const [start, end, repl] of edits) {
    body = body.slice(0, start) + repl + body.slice(end);
  }
  return [body, true];
}

// --- pkg-manager autoupdater redirect ----------------------------------------
// Claude Code's in-TUI autoupdater (the pkg-manager path) spawns an npm/install
// command to fetch a new version, then shows "Update installed · Restart to apply".
// Under clode there is no npm-managed install to update, so that spawn fails. We
// redirect the spawn's argv to `"$CLODE_SELF" --clode-internal-update` (clode's own
// host-agnostic fetch into the provider store) when CLODE_SELF is set, leaving the
// argv untouched otherwise. The override is spliced right after the
// auto_updater_start telemetry call, before the `let[..]=cmd` destructure that
// feeds the spawn — so the spawn sees clode's argv. exit 0 -> the bundle's existing
// success path renders "Restart to apply"; the next clode launch re-extracts the
// freshly-fetched provider. Anchor PROVEN against real 2.1.179; same identifier
// bounding rationale as the doctor anchors (short minified ids, linear scan).
const AUTOUPDATER_SPAWN =
  /(?<pre>tengu_pkg_manager_auto_updater_start",[A-Za-z0-9_$]{1,6}\);)let\[[A-Za-z0-9_$]{1,6},\.\.\.[A-Za-z0-9_$]{1,6}\]=(?<cmd>[A-Za-z0-9_$]{1,6}),[A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(/g;

// Override the pkg-manager autoupdater's spawn argv to call
// `clode --clode-internal-update` (when CLODE_SELF is set). exit 0 -> the bundle's
// existing success path shows "Update installed · Restart to apply"; next launch
// re-extracts. Returns [newBody, applied]; applied false unless exactly one match
// (fail-loud).
function patchAutoupdater(body) {
  const m = [...body.matchAll(AUTOUPDATER_SPAWN)];
  if (m.length !== 1) return [body, false];
  const cmd = m[0].groups.cmd;
  const pre = m[0].groups.pre;
  const override = cmd + '=process.env.CLODE_SELF?[process.env.CLODE_SELF,"--clode-internal-update"]:' + cmd + ';';
  const cut = m[0].index + pre.length;
  return [body.slice(0, cut) + override + body.slice(cut), true];
}

// --- native autoupdater redirect ---------------------------------------------
// Claude Code's in-TUI NATIVE autoupdater installs in-process: after the
// `tengu_native_auto_updater_start` telemetry it does `try{let T=await <fn>(<arg>),…`
// where <fn> returns {wasUpdated,latestVersion,lockFailed}. Under clode that native
// install is wrong (clode runs extracted JS, not a native install). We replace the
// call with a CLODE_SELF-guarded clode spawn (globalThis.__clodeNativeUpdate, set
// in the prelude) that resolves a success-shaped result, so the bundle's existing
// "Restart to apply" path runs and the next launch re-extracts. The `,` after the
// call bounds <arg>. Same fail-loud contract as the pkg-manager redirect. Anchor
// PROVEN against real 2.1.179.
const NATIVE_AUTOUPDATER =
  /(?<pre>tengu_native_auto_updater_start",(?:\{\}|[A-Za-z0-9_$]{1,6})\);try\{let [A-Za-z0-9_$]{1,6}=await )(?<call>[A-Za-z0-9_$]{1,6}\([A-Za-z0-9_$]{1,6}\)),/g;

// Redirect the in-TUI NATIVE autoupdater to clode's internal fetch (when
// CLODE_SELF is set). Replaces `await <fn>(<arg>)` with
// `await (process.env.CLODE_SELF?globalThis.__clodeNativeUpdate():<fn>(<arg>))`.
// Returns [newBody, applied]; applied false unless exactly one match (fail-loud).
function patchNativeAutoupdater(body) {
  const m = [...body.matchAll(NATIVE_AUTOUPDATER)];
  if (m.length !== 1) return [body, false];
  const pre = m[0].groups.pre;
  const call = m[0].groups.call;
  const override = pre + '(process.env.CLODE_SELF?globalThis.__clodeNativeUpdate():'
    + call + '),';
  return [body.slice(0, m[0].index) + override + body.slice(m[0].index + m[0][0].length), true];
}

// Rewrite *body* to be Node CJS-compatible and prepend the prelude. Replaces all
// `import.meta` references with `__import_meta` (defined by the prelude), then
// contributes the clode applet-skew finding to /doctor's installation warnings,
// wires /doctor to refresh the skew probe before rendering, and redirects both
// autoupdaters. Replacing inside strings is harmless.
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
  let eager;
  [body, eager] = patchDoctorEager(body);
  if (!eager) {
    process.stderr.write(
      'clode: /doctor eager-snapshot hook NOT applied — generator or doctor-load '
      + 'anchor not found exactly once (Claude version drift?). The applet-skew section '
      + 'still appears after the first shell command; run inspect-claude-bundle --strict.\n');
  }
  let au;
  [body, au] = patchAutoupdater(body);
  if (!au) {
    process.stderr.write(
      'clode: in-TUI autoupdater hook NOT applied — pkg-manager apply anchor not found '
      + 'exactly once (Claude version drift?). `clode update` still works; '
      + 'run inspect-claude-bundle --strict.\n');
  }
  let nau;
  [body, nau] = patchNativeAutoupdater(body);
  if (!nau) {
    process.stderr.write(
      'clode: in-TUI NATIVE autoupdater hook NOT applied — native apply anchor '
      + 'not found exactly once (Claude version drift?). `clode update` still '
      + 'works; run inspect-claude-bundle --strict.\n');
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
  patchDoctorEager,
  patchAutoupdater,
  patchNativeAutoupdater,
  transform,
  verify,
  contentChecks,
  extractToFile,
  main,
  PRELUDE,
};

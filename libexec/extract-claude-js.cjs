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
const MIN_OUTPUT_BYTES = 1000000;

// sys.exit(str) equivalent: write the message + newline to stderr, exit 1.
function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function pickEntry(blocks) {
  if (!blocks.length) {
    die('error: no Bun @bun-cjs entry marker found — format may have changed');
  }
  const named = blocks.find((b) => (b.name || '').endsWith('entrypoints/cli.js'));
  if (named === undefined) {
    const bySize = blocks.reduce((a, b) => (b.size > a.size ? b : a));
    die('error: no block named entrypoints/cli.js; bundle format may have changed '
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
const INSTALL_WARNINGS =
  /return\{installationType:.{0,400}?,warnings:(?<arr>[A-Za-z0-9_$]{1,6}),packageManager:/gs;

function _skewContribution(arr) {
  return (
    'globalThis.__clodeDoctor&&globalThis.__clodeDoctor.appletSkew&&'
    + 'globalThis.__clodeDoctor.appletSkew.forEach(function(s){' + arr + '.push({'
    + 'issue:"host "+s.applet+" rejects flags clode\\u2019s bundled /"+s.name+" uses \\u2014 "+s.why,'
    + 'fix:s.fix||("set CLODE_"+s.applet.toUpperCase()+" to a compatible "+s.applet)'
    + '})});'
  );
}

function patchDoctorWarnings(body) {
  const m = [...body.matchAll(INSTALL_WARNINGS)];
  if (m.length !== 1) return [body, false];
  const inject = _skewContribution(m[0].groups.arr);
  const cut = m[0].index;
  return [body.slice(0, cut) + inject + body.slice(cut), true];
}

// --- doctor eager-snapshot wiring --------------------------------------------
const SNAPSHOT_GEN =
  /async function (?<gen>[A-Za-z0-9_$]{1,6})\(\)\{let (?<h>[A-Za-z0-9_$]{1,6})=await [A-Za-z0-9_$]{1,6}\(\);return\{provider:await [A-Za-z0-9_$]{1,6}\(\k<h>\)\}\}/g;
const DOCTOR_LOAD =
  /(?<prefix>name:"doctor".{0,240}?)load:\(\)=>Promise\.resolve\(\)\.then\((?<cb>\(\) => \([A-Za-z0-9_$]{1,8}\(\),[A-Za-z0-9_$]{1,8}\))\)/gs;
const _DOCTOR_ENSURE =
  '()=>{var g=globalThis.__clodeEnsureSnapshot;'
  + 'return g?Promise.resolve().then(g).catch(function(){}):void 0}';

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
const AUTOUPDATER_SPAWN =
  /(?<pre>tengu_pkg_manager_auto_updater_start",[A-Za-z0-9_$]{1,6}\);)let\[[A-Za-z0-9_$]{1,6},\.\.\.[A-Za-z0-9_$]{1,6}\]=(?<cmd>[A-Za-z0-9_$]{1,6}),[A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(/g;

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
const NATIVE_AUTOUPDATER =
  /(?<pre>tengu_native_auto_updater_start",(?:\{\}|[A-Za-z0-9_$]{1,6})\);try\{let [A-Za-z0-9_$]{1,6}=await )(?<call>[A-Za-z0-9_$]{1,6}\([A-Za-z0-9_$]{1,6}\)),/g;

function patchNativeAutoupdater(body) {
  const m = [...body.matchAll(NATIVE_AUTOUPDATER)];
  if (m.length !== 1) return [body, false];
  const pre = m[0].groups.pre;
  const call = m[0].groups.call;
  const override = pre + '(process.env.CLODE_SELF?globalThis.__clodeNativeUpdate():'
    + call + '),';
  return [body.slice(0, m[0].index) + override + body.slice(m[0].index + m[0][0].length), true];
}

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

function main(argv) {
  const pos = argv.filter((a) => !a.startsWith('-'));
  if (pos.length !== 2) {
    die(DOC);
  }
  const [binpath, out] = pos;
  const data = fs.readFileSync(binpath, 'latin1');
  const entry = pickEntry(carveBlocks(data));
  const text = transform(entry.body);
  fs.writeFileSync(out, Buffer.from(text, 'latin1'));
  const problems = verify(text).concat(contentChecks(text));
  if (problems.length) {
    try { fs.rmSync(out); } catch (e) { /* ignore */ }
    die('error: extraction failed verification:\n  - ' + problems.join('\n  - '));
  }
  process.stderr.write(`entry=${entry.name || '<unknown>'}\nwrote ${out} (${text.length} bytes)\n`);
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
  main,
  PRELUDE,
};

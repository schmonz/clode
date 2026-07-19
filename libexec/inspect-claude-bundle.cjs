#!/usr/bin/env node
'use strict';
// inspect-claude-bundle.cjs  <claude-native-binary | extracted-cli.cjs>  [options]
//
// JS port of libexec/inspect-claude-bundle (the Python oracle). Produces
// IDENTICAL --json output and IDENTICAL --strict exit codes. Faithful 1:1
// translation, function-for-function, using the latin1 round-trip (1 char ==
// 1 byte) so byte regexes become latin1-string regexes. See the Python file for
// the full design rationale.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nearestName } = require('./bundle-carve.cjs');

// __doc__ equivalent: reproduced verbatim from the Python module docstring so the
// usage/error path prints identical text. (Python sys.exit(__doc__) prints this
// to stderr with a trailing newline and exits 1.)
const DOC = `inspect-claude-bundle  <claude-native-binary | extracted-cli.cjs>  [options]

Report what a Claude Code bundle needs from the Node host, and (with --shim)
exactly which of those needs our extracted JS version does NOT yet account for.
Dependency-free. Rerun on each \`claude update\` to track surface drift.

Options:
  --shim PATH    bun-shim.cjs to compare against (enables the coverage report)
  --node PATH    node to load the shim with (default: CLODE_NODE, else first on PATH)
  --coverage     print ONLY the coverage / unaccounted-features report
  --json         machine-readable output
  --strict       exit non-zero if any upstream feature is unaccounted for

Reports:
  * Bun.* API surface  — every real \`Bun.<member>\` referenced, with counts.
  * bun: modules       — every require/import("bun:..."); flags unhandled ones.
  * embedded assets    — native .node/.wasm blobs = optional features that are
                         disabled under the loose-JS host.
  * @bun-cjs blocks    — module name + size of each carved block (entry first).
  * COVERAGE (--shim)  — classifies each upstream need as implemented / stubbed
                         (provided but throws) / missing / disabled-native, and
                         lists everything UNACCOUNTED FOR.
`;

// MARKER: the inspector computes a RAW block size (next-NUL minus body-start, no
// rstrip/`})` trim), unlike bundle-carve's trimmed size — so we keep our own
// MARKER + size loop here (nearestName is shared). \b/\x00 are byte-identical on
// a latin1 string.
const MARKER = /\/\/ @bun\b[^\n]*@bun-cjs\n\(function\(exports, require, module, __filename, __dirname\) \{/g;
const BUN_API = /\bBun\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
// Python `\s` on bytes == ASCII whitespace only; JS `\s` matches Unicode (e.g.
// 0xa0 in a latin1 string), so spell out the ASCII class for byte-parity.
const BUN_MOD = /(?:require|import)\([ \t\n\r\x0b\x0c]*["'](bun:[\w./-]+)["']/g;
const REQ_ANY = /(?:require|import)\([ \t\n\r\x0b\x0c]*["']([^"']+)["']/g;
const ASSET = /[\w./$-]{3,90}\.(?:node|wasm)\x00/g;
const JSON_TXT = /[\w./$-]{3,90}\.(?:json|txt)\x00/g;

const KNOWN_BUN = new Set([
  'serve', 'fetch', 'file', 'write', 'spawn', 'spawnSync', 'which', 'env',
  'version', 'revision', 'main', 'argv', 'stdin', 'stdout', 'stderr',
  'Glob', 'build', 'Transpiler', 'FileSystemRouter', 'Terminal',
  'ArrayBufferSink', 'deepEquals', 'deepMatch', 'escapeHTML', 'stringWidth',
  'stripANSI', 'wrapAnsi', 'nanoseconds', 'sleep', 'sleepSync', 'peek',
  'inspect', 'gc', 'generateHeapSnapshot', 'allocUnsafe', 'concatArrayBuffers',
  'readableStreamToArray', 'readableStreamToArrayBuffer', 'readableStreamToBytes',
  'readableStreamToBlob', 'readableStreamToJSON', 'readableStreamToText',
  'readableStreamToFormData', 'resolve', 'resolveSync', 'fileURLToPath',
  'pathToFileURL', 'listen', 'connect', 'udpSocket', 'dns', 'semver', 'hash',
  'CryptoHasher', 'password', 'gzipSync', 'gunzipSync', 'deflateSync',
  'inflateSync', 'color', 'randomUUIDv7', 'indexOfLine', 'mmap', 'openInEditor',
  'enableANSIColors', 'isMainThread', 'plugin', 'registerMacro', 'Cookie',
  'CookieMap', 'S3Client', 'redis', 'sql', 'SQL', 's3', 'YAML', 'JSONL',
  'jest', 'cron', 'Security', 'Database', 'FFI', 'embeddedFiles', '$',
]);

const KNOWN_SEARCH_APPLETS = new Set(['ugrep', 'bfs']);
const SEARCH_APPLET = /[A-Za-z_$][\w$]*\("[a-z][a-z0-9_+-]{0,15}","([a-z][a-z0-9_+-]{1,15})",\["-/g;

function searchApplets(data) {
  const out = new Set();
  for (const m of data.matchAll(SEARCH_APPLET)) out.add(m[1]);
  return out;
}

function unknownSearchApplets(applets) {
  return [...applets].filter((a) => !KNOWN_SEARCH_APPLETS.has(a)).sort();
}

const RIPGREP_LEVER = 'USE_BUILTIN_RIPGREP';
function ripgrepLeverPresent(data) {
  return data.includes(RIPGREP_LEVER);
}

// Anchors — verbatim translations of the Python module-level regexes.
// re.DOTALL -> `s` flag; findall count -> matchAll length; str.count -> substr count.
const _DOCTOR_WARNINGS_ANCHOR = /return\{installationType:.{0,400}?,warnings:[A-Za-z0-9_$]{1,6},packageManager:/gs;
function doctorHookAnchorPresent(data) {
  return [...data.matchAll(_DOCTOR_WARNINGS_ANCHOR)].length === 1;
}

// The eager-snapshot bridge (extract-claude-js patchSnapshotBridge) needs the
// snapshot generator exactly once. Its old companion DOCTOR_LOAD anchor is
// RETIRED: upstream 2.1.205 reworked /doctor into a prompt-driven agent command
// with no load site; the eager work now rides the installation-warnings splice
// (see _DOCTOR_WARNINGS_ANCHOR above), so no doctor-command-shaped anchor exists.
const SNAPSHOT_GEN_ANCHOR = 'return{provider:await ';
function snapshotGeneratorPresent(data) {
  return countSubstr(data, SNAPSHOT_GEN_ANCHOR) === 1;
}

// Mirrors extract-claude-js.cjs AUTOUPDATER_SPAWN (sans the capture groups it
// doesn't need): comma form (<=2.1.202) OR split-let form (2.1.203-2.1.207) OR
// direct form (2.1.210+) after `=<cmd>`. Keep the two in step — this one is the
// gate that says the redirect WOULD apply, so a shape the extractor accepts and
// this rejects (or vice versa) is a lie in one direction or the other.
const _AUTOUPDATER_ANCHOR = /tengu_pkg_manager_auto_updater_start",[A-Za-z0-9_$]{1,6}\);let\[(?<a>[A-Za-z0-9_$]{1,6}),\.\.\.(?<rest>[A-Za-z0-9_$]{1,6})\]=[A-Za-z0-9_$]{1,6}(?:,[A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=\k<a>;let [A-Za-z0-9_$]{1,6}=\k<rest>;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(\k<a>,\k<rest>,)/g;
const _AUTOUPDATER_PATCHED = 'process.env.CLODE_SELF?[process.env.CLODE_SELF,"--clode-internal-update"]';
function autoupdaterHookAnchorPresent(data) {
  return [...data.matchAll(_AUTOUPDATER_ANCHOR)].length === 1 || data.includes(_AUTOUPDATER_PATCHED);
}

const _NATIVE_AUTOUPDATER_ANCHOR = /tengu_native_auto_updater_start",(?:\{\}|[A-Za-z0-9_$]{1,6})\);try\{let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\([A-Za-z0-9_$]{1,6}\),/g;
const _NATIVE_AUTOUPDATER_PATCHED = 'process.env.CLODE_SELF?globalThis.__clodeNativeUpdate()';
function nativeAutoupdaterHookAnchorPresent(data) {
  return [...data.matchAll(_NATIVE_AUTOUPDATER_ANCHOR)].length === 1 || data.includes(_NATIVE_AUTOUPDATER_PATCHED);
}

const APPLET_VERSION = {
  ugrep: /\bugrep (\d+\.\d+\.\d+)/,
  bfs: /\bbfs (\d+\.\d+(?:\.\d+)?)/,
  rg: /\bripgrep (\d+\.\d+\.\d+)/,
};
const APPLET_ENV = { ugrep: 'CLODE_UGREP', bfs: 'CLODE_BFS', rg: 'CLODE_RG' };

function embeddedAppletVersions(data) {
  const out = {};
  for (const applet of Object.keys(APPLET_VERSION)) {
    const m = APPLET_VERSION[applet].exec(data);
    out[applet] = m ? m[1] : null;
  }
  return out;
}

function which(name) {
  const pathenv = process.env.PATH != null ? process.env.PATH : '';
  for (const dir of pathenv.split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      const st = fs.statSync(cand);
      if (st.isFile()) { fs.accessSync(cand, fs.constants.X_OK); return cand; }
    } catch (_) { /* not here */ }
  }
  return null;
}

function hostAppletVersion(applet, env, spawn = spawnSync) {
  const e = env != null ? env : process.env;
  const exe = e[APPLET_ENV[applet] || ''] || which(applet);
  if (!exe) return null;
  let p;
  try {
    p = spawn(exe, ['--version'], { encoding: 'utf8', timeout: 5000 });
  } catch (_) {
    return null;
  }
  if (p.error) return null;
  const text = (p.stdout || '') + '\n' + (p.stderr || '');
  const m = /\d+\.\d+(?:\.\d+)?/.exec(text);
  return m ? m[0] : null;
}

// Map embedded native-addon basenames to upstream features (insertion order
// matters: first startsWith match wins).
const NATIVE_FEATURES = [
  ['better_sqlite3', 'SQLite storage (bun:sqlite / history, todos)'],
  ['sharp', 'image processing / resizing (sharp)'],
  ['image-processor', 'image paste / processing'],
  ['audio-capture', 'audio capture (voice input)'],
  ['computer-use-swift', 'computer-use (screen control, macOS Swift)'],
  ['computer-use-input', 'computer-use (input injection)'],
  ['url-handler', 'macOS URL-scheme handler'],
  ['modifiers', 'keyboard modifier capture'],
  ['msal.js', 'Microsoft auth (MSAL) native bits'],
];

function countSubstr(hay, needle) {
  if (needle === '') return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n += 1;
    i = j + needle.length;
  }
  return n;
}

function count(regex, data) {
  const out = {};
  for (const m of data.matchAll(regex)) {
    const key = m[1];
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function featureForAsset(asset) {
  const base = path.basename(asset);
  for (const [stem, desc] of NATIVE_FEATURES) {
    if (base.startsWith(stem)) return desc;
  }
  return null;
}

// dict(sorted(items, key=(-count, key)))
function sortByCountThenKey(obj) {
  const o = {};
  const entries = Object.entries(obj).sort(
    (a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, v] of entries) o[k] = v;
  return o;
}

// dict(sorted(items)) — by key ascending
function sortByKey(obj) {
  const o = {};
  for (const k of Object.keys(obj).sort()) o[k] = obj[k];
  return o;
}

function inspect(p) {
  const data = fs.readFileSync(p, 'latin1');

  const bunApi = count(BUN_API, data);
  const bunMods = count(BUN_MOD, data);

  const assets = [...new Set([...data.matchAll(ASSET)].map((m) => m[0].replace(/\x00+$/, '')))].sort();
  const jsonTxt = [...new Set([...data.matchAll(JSON_TXT)].map((m) => m[0].replace(/\x00+$/, '')))].sort();

  const blocks = [];
  for (const m of data.matchAll(MARKER)) {
    const bodyStart = m.index + m[0].length;
    const nul = data.indexOf('\x00', bodyStart);
    const end = nul !== -1 ? nul : data.length;
    const size = data.slice(bodyStart, end).length;
    blocks.push({ name: nearestName(data, m.index), size });
  }
  blocks.sort((a, b) => b.size - a.size);

  // External module specifiers: bare (non-relative, non-bun:) require/import.
  const ext = {};
  const validSpec = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
  for (const m of data.matchAll(REQ_ANY)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('bun:') || spec.startsWith('node:')) {
      continue;
    }
    if (!validSpec.test(spec)) continue;
    ext[spec] = (ext[spec] || 0) + 1;
  }

  const real = {};
  const unrecognized = {};
  for (const [k, v] of Object.entries(bunApi)) {
    if (KNOWN_BUN.has(k)) real[k] = v;
    else unrecognized[k] = v;
  }

  // distinct features backed by embedded native addons (dedup by description)
  const disabled = [...new Set(assets.map(featureForAsset).filter((f) => f))].sort();

  // KEY ORDER IS A --json BYTE CONTRACT: pyJson() serializes with sortKeys:false,
  // so the insertion order below is the on-disk order. Keep field order in sync;
  // do NOT alphabetize. (inspect-diff.test.cjs catches a reorder while the Python
  // oracle exists; after it's deleted this comment is the only guard.)
  return {
    file: p,
    bytes: data.length,
    embeddedFiles_consumed: Object.prototype.hasOwnProperty.call(bunApi, 'embeddedFiles'),
    bun_api_real: sortByCountThenKey(real),
    bun_api_unrecognized: sortByCountThenKey(unrecognized),
    bun_modules: sortByKey(bunMods),
    external_modules: sortByCountThenKey(ext),
    embedded_assets: assets,
    disabled_native_features: disabled,
    json_txt_names: jsonTxt,
    bun_cjs_blocks: blocks,
    search_applets: [...searchApplets(data)].sort(),
    embedded_applet_versions: embeddedAppletVersions(data),
    doctor_hook_anchor_present: doctorHookAnchorPresent(data),
    autoupdater_hook_anchor_present: autoupdaterHookAnchorPresent(data),
    native_autoupdater_hook_anchor_present: nativeAutoupdaterHookAnchorPresent(data),
    snapshot_generator_present: snapshotGeneratorPresent(data),
    ripgrep_lever_present: ripgrepLeverPresent(data),
  };
}

function probeShim(shimPath, node, specifiers) {
  if (!(shimPath && fs.existsSync(shimPath))) return null;
  const code = `
const shim = require(process.argv[1]);
const specs = JSON.parse(process.argv[2]);
const Module = require('module');
const B = globalThis.Bun || {};
const keys = Object.keys(B);
// __bunShimStub tags throwing function stubs AND object-valued stubs (e.g. Bun.YAML
// when the \`yaml\` dep is absent), so match any tagged value, not just functions.
const stubs = keys.filter(k => B[k] != null && B[k].__bunShimStub === true);
const hostModules = new Set(shim.__hostModules || []);
const bunBuiltins = new Set(shim.__bunBuiltins || []);
const isBuiltin = Module.isBuiltin || ((n) => require('module').builtinModules.includes(n.replace(/^node:/, '')));
const modules = {};
for (const s of specs) {
  if (bunBuiltins.has(s)) { modules[s] = 'bun-builtin'; continue; }
  if (isBuiltin(s)) { modules[s] = 'builtin'; continue; }
  let resolved = false;
  try { require.resolve(s); resolved = true; } catch (_) {}
  if (resolved) modules[s] = 'installed';
  else if (hostModules.has(s)) modules[s] = 'host-stub';
  else modules[s] = 'MISSING';
}
process.stdout.write(JSON.stringify({ keys, stubs, modules }));
`;
  try {
    const out = spawnSync(node, ['-e', code, path.resolve(shimPath), JSON.stringify(specifiers)],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    if (out.error) return null;
    if (out.status !== 0) return null;
    return JSON.parse(out.stdout);
  } catch (_) {
    return null;
  }
}

const HANDLED_BUN_MODULES = new Set(['bun:ffi']);

const ACCEPTED_MISSING_EXTERNALS = new Set([
  'ws',
  'esbuild', 'typescript',
  'playwright', 'playwright-core',
  'react', 'react-dom', 'react-dom/client',
  'node-fetch',
  'ajv-formats/dist/formats',
  'ajv/dist/runtime/equal', 'ajv/dist/runtime/ucs2length',
  'ajv/dist/runtime/uri', 'ajv/dist/runtime/validation_error',
]);

const ACCEPTED_STUBBED_BUN = new Set(['serve', 'listen', 'file', 'write', 'Terminal', 'Transpiler',
  'YAML', 'stringWidth', 'stripANSI', 'wrapAnsi', 'semver']);
const ACCEPTED_MISSING_BUN = new Set(['SQL']);
const ACCEPTED_BUN_MODULES = new Set(['bun:jsc']);

function gateProblems(cov) {
  let p = [];
  p = p.concat(cov.stubbed.filter((k) => !ACCEPTED_STUBBED_BUN.has(k)).map((k) => `Bun.${k} (stubbed)`));
  p = p.concat(cov.missing.filter((k) => !ACCEPTED_MISSING_BUN.has(k)).map((k) => `Bun.${k} (missing)`));
  p = p.concat(cov.bun_modules_unhandled.filter((m) => !ACCEPTED_BUN_MODULES.has(m)).map((m) => `${m} (bun: module unhandled)`));
  p = p.concat(cov.modules_missing.filter((m) => !ACCEPTED_MISSING_EXTERNALS.has(m)).map((m) => `${m} (external require MISSING)`));
  p = p.concat((cov.search_applets_unknown || []).map((a) => `${a} (search applet unhandled)`));
  if (!getDefault(cov, 'ripgrep_lever_present', true)) {
    p.push('USE_BUILTIN_RIPGREP lever missing (bin/clode set_ripgrep_env would no-op)');
  }
  if (!getDefault(cov, 'doctor_hook_anchor_present', true)) {
    p.push('/doctor installation-warnings anchor missing/ambiguous (applet-skew hook would not apply)');
  }
  if (!getDefault(cov, 'autoupdater_hook_anchor_present', true)) {
    p.push('in-TUI autoupdater anchor missing/ambiguous (clode --clode-internal-update redirect would not apply)');
  }
  if (!getDefault(cov, 'native_autoupdater_hook_anchor_present', true)) {
    p.push('in-TUI native autoupdater anchor missing/ambiguous (clode --clode-internal-update redirect would not apply)');
  }
  if (!getDefault(cov, 'snapshot_generator_present', true)) {
    p.push('snapshot-generator anchor missing/ambiguous (eager-snapshot bridge would not apply)');
  }
  return p.sort();
}

// dict.get(key, default) helper for objects that may omit a key.
function getDefault(obj, key, def) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : def;
}

function coverage(r, shim) {
  const provided = new Set(shim.keys);
  const stubs = new Set(shim.stubs);
  const implemented = [];
  const stubbed = [];
  const missing = [];
  for (const k of Object.keys(r.bun_api_real)) {
    if (stubs.has(k)) stubbed.push(k);
    else if (provided.has(k)) implemented.push(k);
    else missing.push(k);
  }
  const bunModUnhandled = Object.keys(r.bun_modules).filter((m) => !HANDLED_BUN_MODULES.has(m)).sort();
  const mods = shim.modules || {};
  const modulesMissing = Object.keys(mods).filter((m) => mods[m] === 'MISSING').sort();
  const modulesHostStub = Object.keys(mods).filter((m) => mods[m] === 'host-stub').sort();
  // KEY ORDER IS A --json BYTE CONTRACT (pyJson sortKeys:false) — keep in sync.
  // NOTE: this object intentionally OMITS snapshot_generator_present (matches the
  // oracle): the eager bridge is best-effort, so gateProblems()/humanCoverage()
  // read it via getDefault(cov, ..., true) and their branches are always-true /
  // dead by design. Do NOT "fix" by adding it here — it changes --json + --strict.
  return {
    implemented: implemented.slice().sort(),
    stubbed: stubbed.slice().sort(),
    missing: missing.slice().sort(),
    unrecognized: Object.keys(r.bun_api_unrecognized).sort(),
    bun_modules_unhandled: bunModUnhandled,
    modules_missing: modulesMissing,
    modules_host_stub: modulesHostStub,
    disabled_native_features: r.disabled_native_features,
    search_applets_unknown: unknownSearchApplets(new Set(getDefault(r, 'search_applets', []))),
    ripgrep_lever_present: getDefault(r, 'ripgrep_lever_present', true),
    doctor_hook_anchor_present: getDefault(r, 'doctor_hook_anchor_present', true),
    autoupdater_hook_anchor_present: getDefault(r, 'autoupdater_hook_anchor_present', true),
    native_autoupdater_hook_anchor_present: getDefault(r, 'native_autoupdater_hook_anchor_present', true),
  };
}

// %-style padding helpers
function padLeft(n, w) { return String(n).padStart(w); }
function padRight(s, w) { return String(s).padEnd(w); }

function humanSurface(r) {
  const L = [];
  L.push(`file: ${r.file} (${r.bytes} bytes)`);
  L.push('');
  L.push(`@bun-cjs blocks (${r.bun_cjs_blocks.length}):`);
  for (const b of r.bun_cjs_blocks) {
    L.push(`  ${padLeft(b.size, 10)}  ${b.name || '<unnamed>'}`);
  }
  L.push('');
  L.push(`Bun.* API surface (${Object.keys(r.bun_api_real).length} real):`);
  for (const [k, v] of Object.entries(r.bun_api_real)) {
    L.push(`  ${padLeft(v, 4)}x  Bun.${k}`);
  }
  if (Object.keys(r.bun_api_unrecognized).length) {
    L.push('');
    L.push(`  (${Object.keys(r.bun_api_unrecognized).length} unrecognized — new API or minifier noise, triage:)`);
    for (const [k, v] of Object.entries(r.bun_api_unrecognized)) {
      L.push(`    ${padLeft(v, 4)}x  Bun.${k}`);
    }
  }
  L.push('');
  L.push('bun: modules:');
  for (const [k, v] of Object.entries(r.bun_modules)) {
    L.push(`  ${padLeft(v, 4)}x  ${k}${HANDLED_BUN_MODULES.has(k) ? '' : '   <-- UNHANDLED'}`);
  }
  if (!Object.keys(r.bun_modules).length) L.push('  (none)');
  L.push('');
  L.push(`embedded .node/.wasm assets (${r.embedded_assets.length}) -> disabled features under loose JS:`);
  for (const f of r.disabled_native_features) L.push(`  - ${f}`);
  L.push('');
  L.push(`external module require()s (${Object.keys(r.external_modules).length}) — non-builtin specifiers:`);
  for (const [k, v] of Object.entries(r.external_modules)) {
    L.push(`  ${padLeft(v, 4)}x  ${k}`);
  }
  return L.join('\n');
}

function humanApplets(r, env, spawn = spawnSync) {
  const emb = getDefault(r, 'embedded_applet_versions', {});
  const set = new Set(getDefault(r, 'search_applets', []));
  for (const a of Object.keys(emb)) if (emb[a]) set.add(a);
  const applets = [...set].sort();
  if (!applets.length) return '';
  const L = ['search applets (embedded in bundle vs host):'];
  for (const a of applets) {
    const e = emb[a];
    const h = hostAppletVersion(a, env, spawn);
    let note;
    if (h === null) note = '(not installed on host)';
    else if (e && h !== e) note = '<-- host differs; flag skew possible (bun-shim probes at refresh)';
    else note = '';
    L.push(`  ${padRight(a, 6)} embedded ${padRight(e || '?', 8)} host ${padRight(h || '-', 10)} ${note}`);
  }
  return L.join('\n');
}

function humanCoverage(r, cov) {
  const L = [];
  const real = Object.keys(r.bun_api_real).length;
  L.push('=== COVERAGE: upstream needs vs extracted-JS host ===');
  L.push(`Bun.* real members used by bundle: ${real}`);
  L.push(`  implemented : ${cov.implemented.length}`);
  L.push(`  stubbed     : ${cov.stubbed.length}  (provided but throw if exercised)`);
  L.push(`  missing     : ${cov.missing.length}  (not provided at all)`);
  L.push('');
  const unaccounted = cov.stubbed.length + cov.missing.length + cov.bun_modules_unhandled.length
    + cov.modules_missing.length;
  L.push(`--- UNACCOUNTED FOR (${cov.stubbed.length + cov.missing.length} Bun.* + ${cov.bun_modules_unhandled.length} bun: modules + ${cov.modules_missing.length} ext modules + ${cov.disabled_native_features.length} native features) ---`);
  if (cov.modules_missing.length) {
    L.push('MISSING external modules (require() will reject -> SILENT TUI HANG risk):');
    for (const m of cov.modules_missing) L.push(`  ${m}`);
  }
  if (cov.modules_host_stub.length) {
    L.push('HOST-STUBBED modules (resolve to a shim; feature degraded):');
    for (const m of cov.modules_host_stub) L.push(`  ${m}`);
  }
  if (cov.stubbed.length) {
    L.push('STUBBED (throw when used):');
    for (const k of cov.stubbed) L.push(`  Bun.${k}`);
  }
  if (cov.missing.length) {
    L.push('MISSING (not on the shim):');
    for (const k of cov.missing) L.push(`  Bun.${k}`);
  }
  if (cov.bun_modules_unhandled.length) {
    L.push('UNHANDLED bun: modules:');
    for (const m of cov.bun_modules_unhandled) L.push(`  ${m}`);
  }
  if (cov.disabled_native_features.length) {
    L.push('DISABLED native-addon features (cannot run under loose JS):');
    for (const f of cov.disabled_native_features) L.push(`  - ${f}`);
  }
  if (cov.unrecognized.length) {
    L.push('UNRECOGNIZED Bun.* (triage — new API or noise):');
    for (const k of cov.unrecognized) L.push(`  Bun.${k}`);
  }
  if (cov.search_applets_unknown && cov.search_applets_unknown.length) {
    L.push("UNHANDLED argv0 search applets (bun-shim won't rewrite these shadows):");
    for (const a of cov.search_applets_unknown) L.push(`  ${a}`);
  }
  if (!getDefault(cov, 'ripgrep_lever_present', true)) {
    L.push('MISSING ripgrep lever USE_BUILTIN_RIPGREP (bin/clode set_ripgrep_env would no-op)');
  }
  if (!getDefault(cov, 'doctor_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS /doctor footer anchor (extract-claude-js applet-skew hook would not apply)');
  }
  if (!getDefault(cov, 'autoupdater_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS in-TUI autoupdater anchor (extract-claude-js autoupdater redirect would not apply)');
  }
  if (!getDefault(cov, 'native_autoupdater_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS in-TUI native autoupdater anchor (extract-claude-js native autoupdater redirect would not apply)');
  }
  if (!getDefault(cov, 'snapshot_generator_present', true)) {
    L.push('MISSING/AMBIGUOUS snapshot-generator anchor (eager-snapshot bridge would not apply)');
  }
  return [L.join('\n'), unaccounted];
}

function opt(flag, def = null) {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return (i !== -1 && i + 1 < a.length) ? a[i + 1] : def;
}

function main() {
  // pyJson required lazily here (not at top) so requiring this module for its
  // exports (e.g. the unit tests) doesn't pull in clode-jsutil.
  const { pyJson } = require('./clode-jsutil.cjs');
  const argv = process.argv.slice(2);
  const consumed = new Set([opt('--shim'), opt('--node')]);
  const args = argv.filter((a) => !a.startsWith('-') && !consumed.has(a));
  if (args.length !== 1) {
    process.stderr.write(DOC + '\n');
    process.exit(1);
  }
  const onlyCov = argv.includes('--coverage');
  const asJson = argv.includes('--json');
  const strict = argv.includes('--strict');

  const r = inspect(args[0]);
  const node = opt('--node') || process.env.CLODE_NODE || which('node') || 'node';
  const shim = probeShim(opt('--shim'), node, Object.keys(r.external_modules));
  const cov = shim !== null ? coverage(r, shim) : null;

  if (asJson) {
    const out = Object.assign({}, r);
    if (cov !== null) out.coverage = cov;
    process.stdout.write(pyJson(out, { sortKeys: false }) + '\n');
  } else {
    if (!onlyCov) {
      process.stdout.write(humanSurface(r) + '\n');
      const applets = humanApplets(r);
      if (applets) {
        process.stdout.write('\n');
        process.stdout.write(applets + '\n');
      }
    }
    if (cov !== null) {
      const [text] = humanCoverage(r, cov);
      if (!onlyCov) process.stdout.write('\n');
      process.stdout.write(text + '\n');
    } else if (onlyCov) {
      process.stdout.write('(no --shim given; coverage unavailable)\n');
    }
  }

  if (strict && cov === null) {
    process.stderr.write('inspect-claude-bundle: --strict requires --shim '
      + '(the applet/ripgrep gate needs shim coverage)\n');
    process.exit(2);
  }

  if (strict && cov !== null) {
    const problems = gateProblems(cov);
    if (problems.length) {
      process.stderr.write('UNREVIEWED upstream needs (stub/implement in bun-shim, or add to '
        + 'the ACCEPTED_* lists after review):\n');
      for (const x of problems) process.stderr.write(`  ${x}\n`);
    }
    process.exit(problems.length ? 1 : 0);
  }
}

module.exports = {
  MARKER, BUN_API, BUN_MOD, REQ_ANY, ASSET, JSON_TXT, SEARCH_APPLET,
  KNOWN_BUN, KNOWN_SEARCH_APPLETS, NATIVE_FEATURES, HANDLED_BUN_MODULES,
  ACCEPTED_MISSING_EXTERNALS, ACCEPTED_STUBBED_BUN, ACCEPTED_MISSING_BUN, ACCEPTED_BUN_MODULES,
  count, countSubstr, searchApplets, unknownSearchApplets, ripgrepLeverPresent,
  doctorHookAnchorPresent, snapshotGeneratorPresent, autoupdaterHookAnchorPresent,
  nativeAutoupdaterHookAnchorPresent,
  embeddedAppletVersions, hostAppletVersion, which, featureForAsset,
  inspect, probeShim, gateProblems, coverage,
  humanSurface, humanApplets, humanCoverage,
};

if (require.main === module) main();

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
const { findTool } = require('./clode-hosttools.cjs');

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
  // ant: Bun.ant.getPeerUid (unix-socket peer-credential probe). New in 2.1.220;
  // single call site, try/catch-guarded with a null fallback (reviewed 2026-07-27).
  'ant',
  // Reviewed 2026-07-27 (API-gate pass): TOML (Bun.TOML.parse — niche config parse,
  // stubbed with a clear error), WebView (feature-detected via `"WebView" in Bun`,
  // must stay ABSENT so the guard skips it), isStandaloneExecutable (feature-detect
  // via `===true`; shim provides an honest `false`).
  'TOML', 'WebView', 'isStandaloneExecutable',
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
//
// This is a VERBATIM mirror of extract-claude-js.cjs's SNAPSHOT_GEN, and it used
// to be the loose substring `return{provider:await ` instead. That looseness made
// this gate LIE: 2.1.243 gave the generator a storageV5 parameter, the real anchor
// stopped applying, and this check went on reporting the site present on every
// build for three releases. A gate that says "the patch WOULD apply" has to test
// the thing that decides whether it applies.
const _SNAPSHOT_GEN_ANCHOR =
  /async function (?<gen>[A-Za-z0-9_$]{1,6})\((?<arg>[A-Za-z0-9_$]{0,6})\)\{let (?<h>[A-Za-z0-9_$]{1,6})=await [A-Za-z0-9_$]{1,6}\(\);return\{provider:await [A-Za-z0-9_$]{1,6}\(\k<h>(?:,\{storageV5:\k<arg>\})?\)\}\}/g;
// No already-patched alternative is needed (unlike _AUTOUPDATER_PATCHED below):
// patchSnapshotBridge only APPENDS the exposure statement after the generator, so
// the anchor survives its own patch verbatim.
function snapshotGeneratorPresent(data) {
  return [...data.matchAll(_SNAPSHOT_GEN_ANCHOR)].length === 1;
}

// Mirrors extract-claude-js.cjs AUTOUPDATER_SPAWN (sans the capture groups it
// doesn't need): comma form (<=2.1.202) OR split-let form (2.1.203-2.1.207) OR
// direct form (2.1.210+) after `=<cmd>`. Keep the two in step — this one is the
// gate that says the redirect WOULD apply, so a shape the extractor accepts and
// this rejects (or vice versa) is a lie in one direction or the other.
const _AUTOUPDATER_ANCHOR = /tengu_pkg_manager_auto_updater_start",[A-Za-z0-9_$]{1,6}\);let\[(?<a>[A-Za-z0-9_$]{1,6}),\.\.\.(?<rest>[A-Za-z0-9_$]{1,6})\]=[A-Za-z0-9_$]{1,6}(?:,[A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=\k<a>;let [A-Za-z0-9_$]{1,6}=\k<rest>;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(|;let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\(\k<a>,\k<rest>,)/g;
// Notify-only marker: the pkg patch fires the check with the current-version
// global (extract-claude-js patchAutoupdater). Matches an already-patched bundle
// whose base anchor is gone (the injected reassignment sits between the telemetry
// and the destructure).
const _AUTOUPDATER_PATCHED = 'globalThis.__clodeCheckUpdate(globalThis.__clodeCurrentVersion';
function autoupdaterHookAnchorPresent(data) {
  return [...data.matchAll(_AUTOUPDATER_ANCHOR)].length === 1 || data.includes(_AUTOUPDATER_PATCHED);
}

// The lookahead mirrors extract-claude-js.cjs NATIVE_AUTOUPDATER's left-bounded
// VERSION check exactly: this gate says the patch WOULD apply, so a bundle shape
// the extractor accepts (or fail-loud-skips) but this rejects (or accepts) is a
// lie in one direction or the other. `(?<![A-Za-z0-9_$])` requires VERSION:" to be
// a standalone field, not the suffix of a longer name like ENGINE_VERSION:" — see
// the extractor's comment for the full decoy rationale.
const _NATIVE_AUTOUPDATER_ANCHOR = /tengu_native_auto_updater_start",(?:\{\}|[A-Za-z0-9_$]{1,6})\);try\{let [A-Za-z0-9_$]{1,6}=await [A-Za-z0-9_$]{1,6}\((?:[A-Za-z0-9_$]{1,6}|![01])(?:,(?:[A-Za-z0-9_$]{1,6}|![01])){0,4}\),(?=[A-Za-z0-9_$]{1,6}=\{.{0,300}?(?<![A-Za-z0-9_$])VERSION:")/g;
// Notify-only marker: the native patch replaces the installer call with
// `await globalThis.__clodeCheckUpdate("<version>")` (extract-claude-js
// patchNativeAutoupdater). The `("` distinguishes it from the pkg patch's call
// (which passes the current-version global, not a literal).
const _NATIVE_AUTOUPDATER_PATCHED = 'await globalThis.__clodeCheckUpdate("';
function nativeAutoupdaterHookAnchorPresent(data) {
  return [...data.matchAll(_NATIVE_AUTOUPDATER_ANCHOR)].length === 1 || data.includes(_NATIVE_AUTOUPDATER_PATCHED);
}

// The LEGACY npm autoupdater (extract-claude-js patchLegacyAutoupdater) is the
// updater a BUILT TARGET actually mounts: installation type `unknown` is neither
// `native` nor `package-manager`, so AutoUpdaterWrapper falls through to it, and
// every branch of its install dispatch but `development`/`native` calls an
// installer. Mirrors extract-claude-js.cjs LEGACY_AUTOUPDATER exactly (backrefs
// included) — this one is the gate that says the neutralization WOULD apply, so a
// shape the extractor accepts and this rejects (or vice versa) is a lie in one
// direction or the other. Already-patched bundles carry the injected log line
// (the splice sits between the development guard and the dispatch, so the base
// anchor's lookahead no longer matches), so accept that marker too — same
// convention as the two autoupdater checks above.
const _LEGACY_AUTOUPDATER_ANCHOR =
  /if\((?<log>[A-Za-z0-9_$]{1,6})\(`AutoUpdater: Detected installation type: \$\{(?<x>[A-Za-z0-9_$]{1,6})\}`\),\k<x>==="development"\)\{\k<log>\("AutoUpdater: Cannot auto-update development build"\),[A-Za-z0-9_$]{1,6}\(!1\);return\}(?=let [A-Za-z0-9_$]{1,6}(?:,[A-Za-z0-9_$]{1,6}){1,3};if\(\k<x>==="npm-local"\))/g;
const _LEGACY_AUTOUPDATER_PATCHED =
  'AutoUpdater: install skipped: this binary is managed by clode (notify-only)';
function legacyAutoupdaterHookAnchorPresent(data) {
  return [...data.matchAll(_LEGACY_AUTOUPDATER_ANCHOR)].length === 1
    || data.includes(_LEGACY_AUTOUPDATER_PATCHED);
}

// The MANUAL `update` command (extract-claude-js patchManualUpdate) is the second
// caller of the same global installer the legacy autoupdater uses — `<target>
// update`, typed by a human, which update-guard.cjs does not cover (that hook only
// denies the MODEL a `claude update` through Bash). Mirrors extract-claude-js.cjs
// MANUAL_UPDATE_DISPATCH, backrefs included. Already-patched bundles carry the
// sentinel discriminant (the original `<id>.installationType` is gone, so the base
// anchor cannot match), so accept that marker too — same convention as above.
const _MANUAL_UPDATE_ANCHOR =
  /switch\([A-Za-z0-9_$]{1,6}\.installationType\)\{case"npm-local":(?<local>[A-Za-z0-9_$]{1,6})=!0,(?<method>[A-Za-z0-9_$]{1,6})="local";break;case"npm-global":\k<local>=!1,\k<method>="global";break;case"unknown":/g;
const _MANUAL_UPDATE_PATCHED = 'switch("clode-managed-target"){case"npm-local":';
function manualUpdateHookAnchorPresent(data) {
  return [...data.matchAll(_MANUAL_UPDATE_ANCHOR)].length === 1
    || data.includes(_MANUAL_UPDATE_PATCHED);
}

// The update NOTICE (extract-claude-js patchUpdateNotice) rides the installation-
// warnings surface — where the three-state notify actually reaches the user, since
// the native autoupdater widget only renders install outcomes (Task 6). It needs the
// diagnostics-return anchor with the version field (second) AND the warnings array,
// exactly once. Mirrors extract-claude-js.cjs UPDATE_NOTICE_ANCHOR. An already-
// patched bundle carries the awaited check keyed off __clodeCheckUpdate before the
// return, so accept that marker too (mirrors the autoupdater checks).
const _UPDATE_NOTICE_ANCHOR =
  /return\{installationType:[A-Za-z0-9_$]{1,6},version:[A-Za-z0-9_$]{1,6},.{0,400}?,warnings:[A-Za-z0-9_$]{1,6},packageManager:/gs;
const _UPDATE_NOTICE_PATCHED = 'var __clodeUpd=await globalThis.__clodeCheckUpdate(';
// Update-hint rewrite (extract-claude-js patchUpdateHint) rewrites upstream's
// "npm i -g <package>" remediation so a clode-managed binary never tells the user to
// install a stock claude over it. Mirrors extract-claude-js.cjs's two shapes — see
// the long note there. Upstream never emits the package name as a literal; it inlines
// a build-metadata object and reads .PACKAGE_URL off it.
//
// Why this anchor exists at all: patchUpdateHint was pinned to a literal upstream has
// NEVER emitted, and inspect did not report it, so the drift check could not gate it.
// The hook was a no-op on every build for months and every check said fine.
//
// NOT an exactly-once check: the real count is version-dependent (1 on 1.0.100, 3 on
// 2.1.177-2.1.210, 7 on 2.1.218+). Presence is the contract. Already-rewritten bundles
// carry the replacement text, so accept that marker too (mirrors the autoupdater checks).
const _UPDATE_HINT_TPL = /npm i -g \$\{\{[^{}]{0,900}\}\.PACKAGE_URL\}/;
const _UPDATE_HINT_JSX = /"npm i -g ",\{[^{}]{0,900}\}\.PACKAGE_URL/;
const _UPDATE_HINT_PATCHED = 'clode build (this binary is managed by clode)';
function updateHintAnchorPresent(data) {
  return _UPDATE_HINT_TPL.test(data) || _UPDATE_HINT_JSX.test(data)
    || data.includes(_UPDATE_HINT_PATCHED);
}

function updateNoticeHookAnchorPresent(data) {
  return [...data.matchAll(_UPDATE_NOTICE_ANCHOR)].length === 1 || data.includes(_UPDATE_NOTICE_PATCHED);
}

// Remote Control gate-off (extract-claude-js patchRemoteControlUnavailable) needs
// its anchor exactly once. Two shapes, in lockstep with extract-claude-js.cjs:
// the new (>=2.1.219) availability-gate function pinned by its stable "not available
// inside a cloud session" reason, and the old (<=2.1.218) inline api.anthropic.com
// reason guard. Already-patched bundles carry the injected guard, so accept that
// marker too (mirrors the autoupdater checks).
const _REMOTE_CONTROL_GATE_ANCHOR =
  /async function [A-Za-z0-9_$]{1,8}\(\)\{if\([A-Za-z0-9_$]{1,8}\(\)\)return null;if\(!?[A-Za-z0-9_$]{1,8}\(\)\)return [A-Za-z0-9_$]{1,8}\(\);if\([A-Za-z0-9_$]{1,8}\(\)\)return"Remote Control is not available inside a cloud session\."/g;
const _REMOTE_CONTROL_INLINE_ANCHOR =
  /if\(!?[A-Za-z0-9_$]{1,8}\(\)\)return"Remote Control is only available when using Claude via api\.anthropic\.com\."/g;
const _REMOTE_CONTROL_PATCHED = 'globalThis.__clodeWsUnavailable)return"';
function remoteControlHookAnchorPresent(data) {
  return [...data.matchAll(_REMOTE_CONTROL_GATE_ANCHOR)].length === 1
    || [...data.matchAll(_REMOTE_CONTROL_INLINE_ANCHOR)].length === 1
    || data.includes(_REMOTE_CONTROL_PATCHED);
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

// PATH lookup lives in ONE place: clode-hosttools.findTool, which already
// probes PATHEXT on Windows. This file carried a third hand-rolled copy that did
// not -- a bare-name join plus accessSync(X_OK) -- so on a Windows runner it
// reported "no ugrep/bfs" for applets that were installed, and could not find
// node.exe either. Two other copies had the same bug; the shipped one is fixed
// in libexec/bun-shim.cjs, and this one is deleted rather than fixed again.
const which = (name) => findTool(name);


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

// A GRAPH RUNNER IS AN ENVELOPE, AND EVERY CHECK BELOW READS CODE.
//
// From 2.1.243 an extracted bundle can be a graph runner: upstream's ~1,384 modules
// carried as ONE JSON string plus the few lines that run them. Scanning that text
// directly reads JSON, not JavaScript — every `"` in the payload is `\"` — so the
// anchor checks, which look for literal fragments, silently disagree with reality.
//
// It was not subtle when it happened. Three hooks reported MISSING/AMBIGUOUS on a
// correctly patched 2.1.245 — the native autoupdater, the manual `update` switch, and
// the Remote Control gate — because ALL THREE of their patched markers end in or contain
// a double quote:
//
//     await globalThis.__clodeCheckUpdate("
//     switch("clode-managed-target"){case"npm-local":
//     globalThis.__clodeWsUnavailable)return"
//
// The other six anchors passed, which is what made it look like a product bug: a partial
// failure reads as "some hooks did not apply", and the report said in so many words that
// `<target> update` would install upstream over this binary. It would not. The extractor
// had applied all nine hooks and said so.
//
// So decode first and analyse the real thing. Modules are joined in the runner's own
// order, with the prelude, so counts and exactly-once anchor checks mean what they did
// before this format existed.
const GRAPH_RUNNER_MARKER = '//clode:graph-runner:1';

function decodeGraphRunner(p) {
  const head = fs.readFileSync(p, 'utf8', { flag: 'r' });
  if (!head.startsWith(GRAPH_RUNNER_MARKER)) return null;
  const key = 'const __CLODE_GRAPH = JSON.parse(';
  const i = head.indexOf(key);
  if (i < 0) throw new Error(`${p} declares ${GRAPH_RUNNER_MARKER} but carries no graph`);
  const end = head.indexOf(');\n', i);
  if (end < 0) throw new Error(`${p} graph literal is not terminated`);
  const doc = JSON.parse(JSON.parse(head.slice(i + key.length, end)));
  const parts = [doc.prelude || ''];
  for (const name of doc.order) if (doc.sources[name] != null) parts.push(doc.sources[name]);
  return parts.join('\n');
}

function inspect(p) {
  // Packaging facts, best-effort: a synthetic fixture or an already-extracted file is not
  // a Bun container and simply has neither. Never let this throw — inspect's job is to
  // describe whatever it was handed.
  let codeSplitBundle = false;
  let textAssetCount = 0;
  try {
    const bg = require('./bun-graph.cjs');
    const full = bg.loadGraphFull(p);
    const js = full.rows.filter((r) => r.loader === 1);
    codeSplitBundle = js.length > 0 && js[0].moduleFormat === 1;
    textAssetCount = full.rows.filter((r) => r.loader === 13).length;
  } catch (e) { /* not a container we can decode; both stay at their defaults */ }
  const decoded = decodeGraphRunner(p);
  const data = decoded !== null ? decoded : fs.readFileSync(p, 'latin1');

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
    legacy_autoupdater_hook_anchor_present: legacyAutoupdaterHookAnchorPresent(data),
    manual_update_hook_anchor_present: manualUpdateHookAnchorPresent(data),
    update_notice_hook_anchor_present: updateNoticeHookAnchorPresent(data),
    update_hint_anchor_present: updateHintAnchorPresent(data),
    remote_control_hook_anchor_present: remoteControlHookAnchorPresent(data),
    snapshot_generator_present: snapshotGeneratorPresent(data),
    ripgrep_lever_present: ripgrepLeverPresent(data),
    // WHAT UPSTREAM'S PACKAGING IS, reported so the daily drift check can hold an
    // EXPECTATION about it in both directions. Each of these arrived as a broken build
    // rather than as a warning:
    //   2.1.243 went code-split (1,400 modules, no CJS entry) — `clode build` died for
    //   everyone until the graph path existed.
    //   2.1.246 added text rows the bundle require()s by name — a target built without
    //   them boots and dies on its first turn.
    // Registering them means a change in EITHER direction is a daily red with a name,
    // instead of a P0 discovered by a user.
    bundle_is_code_split: codeSplitBundle,
    // BOOLEAN as well as the count, because the drift check gates booleans and the
    // count is the diagnostic. 164 -> 0 and 164 -> 300 are both fine; 164 -> none is a
    // packaging change we must hear about.
    bundle_text_assets_present: textAssetCount > 0,
    bundle_text_assets: textAssetCount,
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
    // NODE_PATH at the ext-dep closure, because that is what a quaude actually IS.
    // Without it this probe reports the world as if deps/claude were not installed:
    // Bun.semver, stringWidth, stripANSI, wrapAnsi and YAML come back "stubbed —
    // throws when used" (all five are reached and working on every driven flow), and
    // ws / node-fetch come back "MISSING -> SILENT TUI HANG risk" though both are in
    // deps/claude/package.json. A gate that overstates risk on exactly the surfaces
    // that matter teaches people to discount it.
    const depsMods = path.resolve(__dirname, '..', 'deps', 'claude', 'node_modules');
    const env = { ...process.env };
    if (fs.existsSync(depsMods)) {
      env.NODE_PATH = env.NODE_PATH ? `${depsMods}${path.delimiter}${env.NODE_PATH}` : depsMods;
    }
    const out = spawnSync(node, ['-e', code, path.resolve(shimPath), JSON.stringify(specifiers)],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, env });
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
  // ts-morph (new in 2.1.241). NOT a dependency of the bundle: the one
  // `await import('ts-morph')` lives at offset ~307891241 INSIDE a template
  // literal — the source text of package-validate.mjs, a helper the
  // cc-design-sync skill writes to disk for the USER's node to run in a
  // directory it creates (`cd .ds-sync && npm i esbuild ts-morph`). Verified
  // by reading the bytes: the surrounding text is escaped template syntax
  // (\` and \${previews}), which only occurs when it is nested string data
  // rather than code. The bundle can never require it. Same shape as esbuild,
  // playwright and react above.
  'ts-morph',
]);

const ACCEPTED_STUBBED_BUN = new Set(['serve', 'listen', 'file', 'write', 'Terminal', 'Transpiler',
  'YAML', 'stringWidth', 'stripANSI', 'wrapAnsi', 'semver',
  // connect (TCP direct-dial), TOML (config parse): niche/feature-gated; stubbed
  // in bun-shim with clear errors rather than left raw-undefined (API-gate pass).
  'connect', 'TOML']);
// SQL: accepted-missing (no SQL feature on the core path). ant: Bun.ant.getPeerUid
// guarded (try/catch, null fallback). WebView: feature-detected via `"WebView" in
// Bun` — must stay ABSENT so the guard skips it (adding it would flip the detect
// and try to call the stub). All safe to leave unimplemented.
const ACCEPTED_MISSING_BUN = new Set(['SQL', 'ant', 'WebView']);
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
    p.push('in-TUI autoupdater anchor missing/ambiguous (notify-only __clodeCheckUpdate redirect would not apply)');
  }
  if (!getDefault(cov, 'native_autoupdater_hook_anchor_present', true)) {
    p.push('in-TUI native autoupdater anchor missing/ambiguous (notify-only __clodeCheckUpdate redirect would not apply)');
  }
  if (!getDefault(cov, 'legacy_autoupdater_hook_anchor_present', true)) {
    p.push('LEGACY autoupdater install-dispatch anchor missing/ambiguous (a built target, installation type `unknown`, would `bun/npm install -g @anthropic-ai/claude-code` over itself)');
  }
  if (!getDefault(cov, 'manual_update_hook_anchor_present', true)) {
    p.push('manual `update` command installation-type switch missing/ambiguous (`<target> update` would install upstream over this binary instead of refusing)');
  }
  if (!getDefault(cov, 'update_notice_hook_anchor_present', true)) {
    p.push('installation-warnings version+warnings anchor missing/ambiguous (three-state update notice would not surface on /status or `claude doctor`)');
  }
  if (!getDefault(cov, 'remote_control_hook_anchor_present', true)) {
    p.push('Remote Control cBo reason anchor missing/ambiguous (quaude gate-off notice would not apply -> silent no-op)');
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
    legacy_autoupdater_hook_anchor_present: getDefault(r, 'legacy_autoupdater_hook_anchor_present', true),
    manual_update_hook_anchor_present: getDefault(r, 'manual_update_hook_anchor_present', true),
    update_notice_hook_anchor_present: getDefault(r, 'update_notice_hook_anchor_present', true),
    update_hint_anchor_present: getDefault(r, 'update_hint_anchor_present', true),
    remote_control_hook_anchor_present: getDefault(r, 'remote_control_hook_anchor_present', true),
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
  if (!getDefault(cov, 'legacy_autoupdater_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS LEGACY autoupdater install-dispatch anchor (extract-claude-js patchLegacyAutoupdater would not apply -> a built target would install upstream over itself)');
  }
  if (!getDefault(cov, 'manual_update_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS manual `update` installation-type switch (extract-claude-js patchManualUpdate would not apply -> `<target> update` would install upstream over this binary)');
  }
  if (!getDefault(cov, 'update_notice_hook_anchor_present', true)) {
    L.push('MISSING/AMBIGUOUS installation-warnings version+warnings anchor (extract-claude-js update-notice would not surface)');
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
  decodeGraphRunner,
  MARKER, BUN_API, BUN_MOD, REQ_ANY, ASSET, JSON_TXT, SEARCH_APPLET,
  KNOWN_BUN, KNOWN_SEARCH_APPLETS, NATIVE_FEATURES, HANDLED_BUN_MODULES,
  ACCEPTED_MISSING_EXTERNALS, ACCEPTED_STUBBED_BUN, ACCEPTED_MISSING_BUN, ACCEPTED_BUN_MODULES,
  count, countSubstr, searchApplets, unknownSearchApplets, ripgrepLeverPresent,
  doctorHookAnchorPresent, snapshotGeneratorPresent, autoupdaterHookAnchorPresent,
  nativeAutoupdaterHookAnchorPresent, legacyAutoupdaterHookAnchorPresent, manualUpdateHookAnchorPresent,
  updateNoticeHookAnchorPresent, remoteControlHookAnchorPresent,
  embeddedAppletVersions, hostAppletVersion, which, featureForAsset,
  inspect, probeShim, gateProblems, coverage,
  humanSurface, humanApplets, humanCoverage,
};

if (require.main === module) main();

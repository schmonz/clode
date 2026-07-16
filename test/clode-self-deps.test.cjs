'use strict';
// Pins the central claim behind the deps/ split (deps/clode, deps/claude):
// clode ITSELF has zero npm dependencies. Everything bin/clode, libexec/*.cjs,
// and scripts/*.mjs require() is either a node builtin or a sibling file in
// this checkout — never an npm package. That is what makes deps/claude
// (Claude Code's runtime deps, baked into the built quaude/naude) and
// deps/clode (clode's OWN build-time toolchain — esbuild/postject — used to
// COMPILE clode's outputs, never require()'d by clode's own running code)
// genuinely distinct from "clode's deps": clode's actual require graph is
// builtins + relative files, full stop. If this test ever fails, clode has
// grown a real npm dependency and the "the repo root has no dependencies at
// all" claim (deps-move-report.md) is no longer true.
//
// STATIC analysis, not a real load: this walks require()/import specifiers as
// TEXT, rather than actually requiring every file (which would run real
// top-level side effects — spawning toolchains, touching env/filesystem —
// for scripts/*.mjs in particular). Dynamic requires (a computed path or
// variable, not a string literal) are invisible to a text scan and are NOT
// flagged. Every dynamic require() in this codebase was checked by hand when
// this test was written and is legitimate at runtime — clode reading a file
// that happens to live inside an npm-shaped install layout, never clode
// ITSELF depending on that package:
//   - libexec/clode-watch.cjs's loadSemver(): require(pkgDir) where pkgDir is
//     a resolved path INTO a target's semver install (deps/claude or the
//     user's CLODE_DEPS store) — clode reading Claude Code's dep, not
//     depending on one itself.
//   - libexec/inspect-claude-bundle.cjs: require(process.argv[1]) — loads
//     whatever bundle file the caller named, for introspection.
//   - scripts/apicheck.mjs: require(path.join(REPO, 'test', ...)) — loads a
//     sibling test helper by computed path.
// A genuinely new npm dependency is near-certain to show up as a literal
// require('pkg-name') or import ... from 'pkg-name' somewhere in the graph,
// which this test DOES catch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..');
const BUILTINS = new Set(Module.builtinModules);

// The app/clode boundary — this list IS the documentation of that boundary.
// Files under this repo that run INSIDE a BUILT quaude/naude (baked in as
// fuse/SEA members and executed under CLAUDE CODE's own require graph), not
// inside clode's build pipeline. They legitimately require npm packages
// because Claude Code itself does. Excluded from the walk entirely — we never
// analyze their content, matching how clode's own code never actually
// require()s them either (it reads/embeds their BYTES, or spawns them as a
// subprocess target by path string, but never loads them in-process).
const EXCLUDE_FILES = new Set([
  // The Bun global shim baked into the built quaude/naude. Requires
  // semver/ws/yaml because it runs INSIDE the built target, servicing Claude
  // Code's cli.cjs — not inside clode's own build-time code.
  path.join(REPO, 'libexec', 'bun-shim.cjs'),
]);
const EXCLUDE_DIRS = [
  // The node-shim loader + modules + internal tree: archive members baked
  // into a fused quaude, the RUNTIME environment the built binary boots
  // into. clode's own node-side (this-file's) code never require()s these —
  // clode-fuse.cjs passes this directory's PATH to the fuse worker
  // subprocess, it never loads the files in-process.
  path.join(REPO, 'libexec', 'node-shim'),
];

function isExcluded(file) {
  if (EXCLUDE_FILES.has(file)) return true;
  return EXCLUDE_DIRS.some((d) => file === d || file.startsWith(d + path.sep));
}

// Entry points: every module clode itself loads to do its job — bin/clode
// (the launcher entry), every top-level libexec/*.cjs (the launcher spine +
// subcommands), and every top-level scripts/*.mjs (the build pipeline),
// minus the app-member exclusions above.
function entryPoints() {
  const files = [path.join(REPO, 'bin', 'clode')];
  for (const f of fs.readdirSync(path.join(REPO, 'libexec'))) {
    if (f.endsWith('.cjs') && !f.startsWith('.')) files.push(path.join(REPO, 'libexec', f));
  }
  for (const f of fs.readdirSync(path.join(REPO, 'scripts'))) {
    if (f.endsWith('.mjs') && !f.startsWith('.')) files.push(path.join(REPO, 'scripts', f));
  }
  return files.filter((f) => !isExcluded(f));
}

// Single-pass tokenizer: blanks out comments (// and /* */) and records which
// positions lie inside a string/template literal. Needed because a real
// specifier's own quotes ARE a string (so we can't just discard all strings),
// but a require(/import( SHAPE that appears INSIDE some other string is
// prose, not code — e.g. inspect-claude-bundle.cjs's help text `* bun:
// modules — every require/import("bun:...")`, a backtick-string description
// of what IT scans for in someone ELSE's bundle. A match is only real code
// when its start position is NOT inside a string.
function analyze(src) {
  const n = src.length;
  const clean = new Array(n);
  const inStr = new Array(n).fill(false);
  let mode = 'code'; // 'code' | 'line' | 'block' | 'blockend' | 'str'
  let strCh = null, escapeNext = false;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (mode === 'line') { clean[i] = c === '\n' ? '\n' : ' '; if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { clean[i] = ' '; if (c === '*' && c2 === '/') mode = 'blockend'; continue; }
    if (mode === 'blockend') { clean[i] = ' '; mode = 'code'; continue; }
    if (mode === 'str') {
      clean[i] = c; inStr[i] = true;
      if (escapeNext) { escapeNext = false; continue; }
      if (c === '\\') { escapeNext = true; continue; }
      if (c === strCh) { mode = 'code'; strCh = null; }
      continue;
    }
    if (c === '/' && c2 === '/') { mode = 'line'; clean[i] = ' '; continue; }
    if (c === '/' && c2 === '*') { mode = 'block'; clean[i] = ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = 'str'; strCh = c; clean[i] = c; inStr[i] = true; continue; }
    clean[i] = c;
  }
  return { clean: clean.join(''), inStr };
}

// Extract require()/import/export-from specifiers (see analyze() above for
// why comments AND prose-inside-strings are excluded). Matches:
//   require('x') / require("x")
//   import ... from 'x'   (default/named/namespace, any combination)
//   import('x')           (dynamic import)
//   export ... from 'x'
const SPEC_RE = /(?:\brequire\(\s*|\bimport\s*\(\s*|\bimport\s+[^'"()]*?\bfrom\s+|\bexport\s+[^'"()]*?\bfrom\s+)['"]([^'"]+)['"]/g;

function specifiersIn(src) {
  const { clean, inStr } = analyze(src);
  const out = [];
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(clean))) {
    if (!inStr[m.index]) out.push(m[1]);
  }
  return out;
}

// Resolve a relative specifier to a real file on disk, trying the same
// extension fallbacks node's resolver would. Every relative target in this
// codebase is a plain file (no package.json-driven subpath resolution needed).
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.cjs`, `${base}.mjs`, `${base}.js`,
    path.join(base, 'index.cjs'), path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  return null;
}

test('clode itself requires only node builtins + sibling files — no npm dependency', () => {
  const seen = new Set();
  const queue = entryPoints();
  const violations = [];
  const unresolved = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || isExcluded(file)) continue;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) { unresolved.push(`${path.relative(REPO, file)}: cannot read (${e.message})`); continue; }
    for (const spec of specifiersIn(src)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const resolved = resolveRelative(file, spec);
        if (!resolved) {
          unresolved.push(`${path.relative(REPO, file)}: cannot resolve relative specifier '${spec}'`);
          continue;
        }
        if (!isExcluded(resolved) && !seen.has(resolved)) queue.push(resolved);
        continue;
      }
      if (spec.startsWith('node:')) continue;   // explicit node: builtin
      if (BUILTINS.has(spec)) continue;         // bare builtin name (e.g. legacy 'fs')
      violations.push(`${path.relative(REPO, file)}: requires npm package '${spec}'`);
    }
  }
  assert.deepStrictEqual(unresolved, [],
    `unresolved relative specifiers (fix this test's resolver, or the source):\n${unresolved.join('\n')}`);
  assert.deepStrictEqual(violations, [],
    'clode has grown a real npm dependency — it must require only node builtins + sibling ' +
    `files (see this test's header comment for the excluded app-member boundary):\n${violations.join('\n')}\n` +
    'If this is legitimate, it belongs in deps/claude (Claude Code needs it) or deps/clode ' +
    '(a build-time toolchain need) — never a clode runtime require.');
  // Sanity: the walk actually reached a nontrivial slice of clode's own
  // source, so an empty violations list means "checked and clean", not
  // "walked nothing" (a broken entry-point/exclude wiring would silently
  // report success on zero files).
  assert.ok(seen.size > 15, `suspiciously few files walked (${seen.size}) — entry-point/exclude wiring may be broken`);
});

'use strict';
// THE GATE (duplication audit §1). The ext-dep closure quaude embeds used to be
// hand-transcribed in libexec/quaude-fuse.js while naude DERIVED its own from
// package.json via `npm ci`. Nothing checked the two against each other or
// against package.json, so adding a dependency picked it up for naude with zero
// edits and silently omitted it from quaude — surfacing only at quaude RUN time
// as `Cannot find module`, possibly deep in a session, long after the build
// printed "PONG round-trip ok". A transitive bump rotted the list identically.
//
// The absence of this file is what let them drift. It must FAIL if someone adds
// a dependency to package.json that does not reach quaude.
//
// The closure now travels to the (tjs-hosted, require-less) fuse worker as DATA
// through extras.json. These tests grade the node-side derivation that fills it:
// computeDepClosure/readDirectDeps in libexec/clode-fuse.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
// Claude Code's runtime deps (deps/claude/package.json) — NOT clode's own;
// clode has none (test/clode-self-deps.test.cjs).
const NM = path.join(REPO, 'deps', 'claude', 'node_modules');
const LIBEXEC = path.join(REPO, 'libexec');
const {
  readDirectDeps, computeDepClosure, assertClosureMatchesLockfile,
  scanBareSpecifiers, scannableTexts, specifierPackageName, isBuiltinSpecifier, shimProvidedModules,
  assertNoUnknownBareSpecifiers, KNOWN_UNREACHABLE,
} = require('../libexec/clode-fuse.cjs');

// Build a fake flat node_modules from {name: {dependencies}} — the layout npm
// produces for this closure (no version conflicts, every package a direct child).
function fakeNm(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-closure-'));
  for (const [name, pkg] of Object.entries(spec)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ name, ...pkg }));
  }
  return dir;
}

test('readDirectDeps: package.json dependencies are the source of truth', () => {
  const deps = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'deps', 'claude', 'package.json'), 'utf8'));
  assert.deepStrictEqual(deps.sort(), Object.keys(pkg.dependencies).sort());
  // devDependencies must never ride along — quaude ships a RUNTIME closure.
  for (const d of Object.keys(pkg.devDependencies || {})) {
    assert.ok(!deps.includes(d), `devDependency '${d}' leaked into the runtime closure`);
  }
});

test('readDirectDeps: an unreadable manifest throws (never a silent empty closure)', () => {
  assert.throws(() => readDirectDeps('/nonexistent/package.json'), /cannot read .* to compute the ext-dep closure/);
});

// THE GATE ITSELF: every package.json dependency, plus everything they
// transitively require, must be in the closure quaude embeds. Derived
// independently here (walking node_modules manifests) so this test grades the
// production walk rather than restating it.
test('GATE: the closure covers every package.json dependency + their transitives', () => {
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const closure = computeDepClosure(NM, direct);

  // 1. Every DIRECT dependency reaches quaude.
  for (const d of direct) {
    assert.ok(closure.includes(d),
      `package.json dependency '${d}' is NOT in the closure quaude embeds — it would fail at RUN time with "Cannot find module"`);
  }

  // 2. Every TRANSITIVE dependency of anything in the closure is also in it —
  // an independent fixed-point check over the real node_modules manifests.
  for (const name of closure) {
    const pkg = JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      assert.ok(closure.includes(dep),
        `'${dep}' (required by '${name}') is NOT in the closure quaude embeds`);
    }
  }

  // 3. Nothing extra: every member is justified by package.json or by another
  // member's dependencies. Keeps the closure from silently growing.
  const justified = new Set(direct);
  for (const name of closure) {
    const pkg = JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) justified.add(dep);
  }
  for (const name of closure) {
    assert.ok(justified.has(name), `'${name}' is in the closure but nothing depends on it`);
  }
});

// The regression this replaces, in miniature: a dependency added to
// package.json must reach quaude with NO edit anywhere else. Under the old
// hardcoded list this test's assertion is exactly what silently failed.
test('GATE: a NEW package.json dependency reaches the closure with no other edit', () => {
  const nm = fakeNm({
    'new-dep': { dependencies: { 'new-transitive': '^1' } },
    'new-transitive': {},
    existing: {},
  });
  try {
    // Simulates package.json gaining 'new-dep' and nothing else changing.
    const closure = computeDepClosure(nm, ['existing', 'new-dep']);
    assert.ok(closure.includes('new-dep'), 'a new direct dependency must reach quaude');
    assert.ok(closure.includes('new-transitive'), "a new dependency's transitives must reach quaude too");
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('computeDepClosure: walks transitives and dedupes a diamond', () => {
  const nm = fakeNm({
    a: { dependencies: { shared: '^1', b: '^1' } },
    b: { dependencies: { shared: '^1' } },   // diamond: both a and b need shared
    shared: {},
  });
  try {
    assert.deepStrictEqual(computeDepClosure(nm, ['a']), ['a', 'b', 'shared']);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('computeDepClosure: tolerates a dependency cycle (terminates, no repeat)', () => {
  const nm = fakeNm({ x: { dependencies: { y: '^1' } }, y: { dependencies: { x: '^1' } } });
  try {
    assert.deepStrictEqual(computeDepClosure(nm, ['x']), ['x', 'y']);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

// The point of deriving the closure at BUILD time: a needed-but-absent package
// must fail the build loudly, NOT become a runtime "Cannot find module" deep in
// a user's session. quaude's old fuse-time guard only fired for a dep that was
// LISTED-but-missing — never for one that was NEEDED-but-unlisted.
test('computeDepClosure: a missing DIRECT dependency fails loud at build time', () => {
  const nm = fakeNm({ present: {} });
  try {
    assert.throws(() => computeDepClosure(nm, ['present', 'absent']),
      /ext-dep closure: 'absent' \(required by package\.json\) not found/);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('computeDepClosure: a missing TRANSITIVE fails loud and names who required it', () => {
  const nm = fakeNm({ top: { dependencies: { gone: '^1' } } });
  try {
    assert.throws(() => computeDepClosure(nm, ['top']),
      /ext-dep closure: 'gone' \(required by top\) not found/);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

// ---- Task (c): optional vs required peer dependencies -----------------------
// The one real-world case (ws -> bufferutil/utf-8-validate, both optional):
// neither is followed, neither fails the build. A REQUIRED peer is a
// different door onto the same duplication-audit-§1 bug (a dep silently not
// reaching quaude) — so that one must fail loud instead of being skipped.

test('computeDepClosure: an OPTIONAL peer dependency is skipped silently, not followed', () => {
  const nm = fakeNm({
    top: {
      dependencies: {},
      peerDependencies: { 'maybe-peer': '^1' },
      peerDependenciesMeta: { 'maybe-peer': { optional: true } },
    },
    // 'maybe-peer' is deliberately NOT installed here — the real-world case
    // (ws's bufferutil/utf-8-validate are both absent today too). Proves the
    // walk never even looks it up: if it did, this would throw ENOENT/missing
    // instead of just excluding it.
  });
  try {
    assert.deepStrictEqual(computeDepClosure(nm, ['top']), ['top']);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('computeDepClosure: a REQUIRED (non-optional) peer dependency fails loud — the tripwire', () => {
  const nm = fakeNm({
    top: {
      dependencies: {},
      peerDependencies: { 'required-peer': '^1' },
      // no peerDependenciesMeta entry for it -> required by default.
    },
  });
  try {
    assert.throws(() => computeDepClosure(nm, ['top']),
      /'top' declares a REQUIRED peer dependency 'required-peer'/);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('computeDepClosure: a peer marked optional:false fails loud, same as an unlisted peer', () => {
  const nm = fakeNm({
    top: {
      dependencies: {},
      peerDependencies: { 'required-peer': '^1' },
      peerDependenciesMeta: { 'required-peer': { optional: false } },
    },
  });
  try {
    assert.throws(() => computeDepClosure(nm, ['top']),
      /'top' declares a REQUIRED peer dependency 'required-peer'/);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('GATE: the real closure has no REQUIRED peer today (ws\'s peers are both optional) — confirms the decision', () => {
  // Not a re-derivation of the decision (already established: ws is the only
  // package with peers, both optional) — a live check that a future dep bump
  // hasn't quietly added a required one, which would throw here first.
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  assert.doesNotThrow(() => computeDepClosure(NM, direct));
});

// ---- Task (a): the manifest BOM (name@version) -------------------------------

test('computeDepClosure: opts.versions captures each package\'s own version (BOM plumbing)', () => {
  const nm = fakeNm({
    a: { version: '1.2.3', dependencies: { b: '^1' } },
    b: { version: '4.5.6' },
  });
  try {
    const versions = new Map();
    const closure = computeDepClosure(nm, ['a'], { versions });
    assert.deepStrictEqual(closure, ['a', 'b']);
    assert.strictEqual(versions.get('a'), '1.2.3');
    assert.strictEqual(versions.get('b'), '4.5.6');
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('GATE: the real closure resolves a version for every package (the manifest BOM)', () => {
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const versions = new Map();
  const closure = computeDepClosure(NM, direct, { versions });
  const bom = closure.map((name) => `${name}@${versions.get(name)}`);
  for (const name of closure) {
    assert.ok(versions.get(name), `no version resolved for '${name}'`);
  }
  assert.ok(bom.some((s) => s.startsWith('semver@')), bom.join(', '));
  assert.strictEqual(bom.length, closure.length);
});

// ---- Task (b): node_modules must match package-lock.json --------------------

function fakeLockfile(packages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-lock-'));
  const lockfilePath = path.join(dir, 'package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages }));
  return { dir, lockfilePath };
}

test('assertClosureMatchesLockfile: matching versions pass silently', () => {
  const { dir, lockfilePath } = fakeLockfile({ 'node_modules/semver': { version: '7.6.0' } });
  try {
    assert.doesNotThrow(() => assertClosureMatchesLockfile(new Map([['semver', '7.6.0']]), lockfilePath));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertClosureMatchesLockfile: node_modules AHEAD of the lockfile (npm install, not npm ci) fails loud, naming both versions and the fix', () => {
  const { dir, lockfilePath } = fakeLockfile({ 'node_modules/semver': { version: '7.6.0' } });
  try {
    assert.throws(
      () => assertClosureMatchesLockfile(new Map([['semver', '7.5.0']]), lockfilePath),
      /'semver' is 7\.5\.0 under node_modules but package-lock\.json pins 7\.6\.0.*npm ci/,
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertClosureMatchesLockfile: a package missing from the lockfile fails loud and names the fix', () => {
  const { dir, lockfilePath } = fakeLockfile({});
  try {
    assert.throws(
      () => assertClosureMatchesLockfile(new Map([['ghost', '1.0.0']]), lockfilePath),
      /'ghost'.*no entry in.*npm ci/,
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assertClosureMatchesLockfile: an unreadable lockfile fails loud (never a silent pass)', () => {
  assert.throws(() => assertClosureMatchesLockfile(new Map(), '/nonexistent/package-lock.json'),
    /cannot read .* to verify the ext-dep closure matches the lockfile/);
});

test('GATE: the real node_modules matches the real package-lock.json right now', () => {
  // Proves the gate is wired correctly against THIS checkout's actual
  // lockfile shape (v3, packages keyed by 'node_modules/<name>') — a
  // real-world sanity check alongside the synthetic-lockfile unit tests
  // above, which grade the comparison logic in isolation.
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const versions = new Map();
  computeDepClosure(NM, direct, { versions });
  assert.doesNotThrow(() => assertClosureMatchesLockfile(versions, path.join(REPO, 'deps', 'claude', 'package-lock.json')));
});

// ---- The dep-closure DRIFT gate (seed-drift closure) -------------------------
// Everything above grades the closure computed FROM package.json's 7(now 8)
// declared deps. Nothing above checks package.json's deps against what the
// bundle ITSELF references — that belief was never verified. These tests grade
// scanBareSpecifiers/assertNoUnknownBareSpecifiers, which close that gap: see
// .superpowers/sdd/seed-drift-report.md for the full measurement against the
// real 2.1.210 bundle that justifies every KNOWN_UNREACHABLE entry below.

function fakeSrcFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-src-'));
  const file = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(file, content);
  return file;
}

test('scanBareSpecifiers: finds require()/__require()/import() bare specifiers', () => {
  const file = fakeSrcFile(
    'require("semver");'
    + '__require("yaml");'
    + 'x=await import("undici");'
  );
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(file)].sort(), ['semver', 'undici', 'yaml']);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: skips relative/absolute paths and node builtins (bare and node:-prefixed forms)', () => {
  const file = fakeSrcFile(
    'require("./local");'
    + 'require("/abs/path");'
    + 'require("fs");'
    + 'require("node:path");'
    + 'require("node:sqlite");'  // only requireable WITH the node: prefix
    + 'require("semver");'
  );
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(file)], ['semver']);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: collapses subpath specifiers to the package name (scoped and unscoped)', () => {
  const file = fakeSrcFile(
    'require("@modelcontextprotocol/sdk/server/index.js");'
    + 'require("ajv/dist/runtime/uri");'
  );
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(file)].sort(), ['@modelcontextprotocol/sdk', 'ajv']);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: the FLAT (non-graph) fallback path never scans declarative ESM `from \'...\'` (proven noise on the OLD bundle — see seed-drift-report.md)', () => {
  // This is `fakeSrcFile`'s shape — a bare file, no graph.json beside it, so
  // scannableTexts() falls back to a single raw-latin1 chunk with
  // `declarative: false` (see its comment). That fallback is what a
  // pre-2.1.243 flat carve, or any OTHER file, gets — and staying
  // declarative-blind there is still correct: embedded doc/skill text
  // ("import {x} from 'y'" shown to the model) would produce false
  // positives — including specifiers that are not even valid package names,
  // like `from 'now'` inside a comment on the real OLD bundle. The
  // graph-shaped path (task-11 fix round 1) DOES scan declarative imports —
  // see the tests below — because graph.json's `sources` are one module's
  // real code each, not a flat blob mixing code and doc text.
  const file = fakeSrcFile("import { build } from 'esbuild';\nimport { z } from 'zod';\n");
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(file)], []);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

// ---- FIX ROUND 1 (coordinator review, task-11, 2026-09-05) -------------------
// The escaping was fixed; the SYNTAX was not. graph.json's `sources` are ESM
// chunks since 2.1.243, so a NEW upstream dependency arriving as a declarative
// `import X from "newpkg"` (not require()/dynamic import()) passed the fixed
// scanner silently. These pin the fix: DECLARATIVE_PATTERNS applied to CODE
// chunks (sources + prelude), NOT to `assets` (embedded doc/reference text,
// where the same shape reintroduces exactly the prose-noise failure mode the
// original exclusion existed to avoid — see DECLARATIVE_PATTERNS's comment in
// libexec/clode-fuse.cjs); `externals` unioned in; `prelude`/`assets` now feed
// the ordinary require()/import() scan too (previously silently skipped).

function fakeGraphCarve({ sources, prelude, assets, externals }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-graph-round1-'));
  fs.writeFileSync(path.join(dir, 'cli.cjs'), '//clode:graph-runner:1\n');
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({
    sources: sources || {},
    ...(prelude !== undefined ? { prelude } : {}),
    ...(assets !== undefined ? { assets } : {}),
    ...(externals !== undefined ? { externals } : {}),
  }));
  return path.join(dir, 'cli.cjs');
}

test('scanBareSpecifiers: a declarative `import X from "newpkg"` in graph.json sources IS found (the syntax gap, task-11 fix round 1)', () => {
  const cli = fakeGraphCarve({ sources: { '/a.js': 'import X from "newpkg";X();' } });
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(cli)], ['newpkg']);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: a declarative named/export-from import in graph.json sources IS found', () => {
  const cli = fakeGraphCarve({ sources: {
    '/a.js': 'import { connect } from "newpkg-named";',
    '/b.js': 'export { thing } from "newpkg-reexport";',
  } });
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(cli)].sort(), ['newpkg-named', 'newpkg-reexport']);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: graph.json\'s `externals` list is unioned in, builtins filtered', () => {
  const cli = fakeGraphCarve({
    sources: { '/a.js': 'x();' },
    externals: ['fs', 'node:path', 'ws', '@scope/pkg/sub'],
  });
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(cli)].sort(), ['@scope/pkg', 'ws']);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: graph.json\'s `prelude` is scanned (require/import AND declarative)', () => {
  const cli = fakeGraphCarve({
    sources: {},
    prelude: 'require("prelude-req");import X from "prelude-decl";',
  });
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(cli)].sort(), ['prelude-decl', 'prelude-req']);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test('scanBareSpecifiers: graph.json\'s `assets` are scanned for require()/import() but NOT declarative imports', () => {
  const cli = fakeGraphCarve({
    sources: {},
    assets: {
      '/doc.md': 'require("asset-req");import X from "asset-decl";',
    },
  });
  try {
    // asset-req found (require() is scanned everywhere); asset-decl is NOT —
    // assets are doc/reference TEXT, and scanning declarative imports there
    // reproduces the exact prose-noise failure mode this gate's original
    // exclusion existed to avoid (measured: @anthropic-ai/sdk, zod,
    // __ds_raw__, ... — see DECLARATIVE_PATTERNS's comment).
    assert.deepStrictEqual([...scanBareSpecifiers(cli)], ['asset-req']);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

// ---- ESCAPE-BLIND CLASS (BACKLOG item 8, task-11) ----------------------------
// From 2.1.243 the staged cli.cjs is a GRAPH RUNNER: module sources ride
// escaped inside a JS string literal. Measured against the real pinned 2.1.251
// carve: scanning cli.cjs directly found {esbuild, playwright, playwright-core,
// ts-morph} (single-quoted doc TEXT that survives JSON.stringify's escaping by
// coincidence) while MISSING {ajv, ajv-formats, bun:jsc, node-fetch} — the
// REAL double-quoted require()/import() calls graph.json's `sources` carry.
// Two entirely disjoint 4-name sets: proof the scan was reading the wrong
// text, not merely being conservative. These tests pin the fix.

test('scanBareSpecifiers: escape-blind class — the bare quote pattern genuinely cannot see an escaped require()', () => {
  // First, the premise: prove the ORIGINAL bug is real, not assumed. A real
  // module source containing a double-quoted require, escaped ONE level the
  // way a graph runner embeds it as a JS string literal, defeats the bare
  // `["']` quote class outright — no backslash-tolerant fallback exists in
  // the pattern itself.
  const realModuleSrc = 'require("totally-real-dep");';
  const runnerEmbedded = JSON.stringify(realModuleSrc);
  assert.ok(runnerEmbedded.includes('\\"totally-real-dep\\"'),
    'test setup is wrong: the escaped form does not even contain a backslash-quoted spec');
  const bareQuotePattern = /require\(["']([a-zA-Z0-9_/:@.-]+)["']\)/;
  assert.strictEqual(bareQuotePattern.test(runnerEmbedded), false,
    'premise failed: the bare quote pattern DOES match escaped text — the class this test '
    + 'guards against is gone (or was never real), and this test needs rewriting, not deleting');
});

test('scanBareSpecifiers: reads graph.json\'s real sources beside cli.cjs, not the escaped runner text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-graph-'));
  try {
    const realModuleSrc = 'require("totally-real-dep");';
    // What the SAME text looks like once embedded in a graph runner (escaped,
    // sitting inside cli.cjs) — the previous test proves this defeats the raw
    // pattern. If scanBareSpecifiers still found 'totally-real-dep' via a raw
    // scan of THIS file, that would mean it got lucky, not fixed.
    fs.writeFileSync(path.join(dir, 'cli.cjs'), `//clode:graph-runner:1\nconst x=${JSON.stringify(realModuleSrc)};\n`);
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ sources: { '/a.js': realModuleSrc } }));
    assert.deepStrictEqual([...scanBareSpecifiers(path.join(dir, 'cli.cjs'))], ['totally-real-dep'],
      'scanBareSpecifiers must read graph.json\'s `sources` map (real strings), not grep the '
      + 'escaped runner text it rides beside');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scannableTexts: falls back to a raw read when no graph.json rides beside cli.cjs (pre-2.1.243 flat carve)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-flat-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.cjs'), 'require("flat-carve-dep");');
    assert.deepStrictEqual([...scanBareSpecifiers(path.join(dir, 'cli.cjs'))], ['flat-carve-dep']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scannableTexts: a file not literally named cli.cjs is scanned as raw text even with a graph.json beside it (bun-shim.cjs)', () => {
  // bun-shim.cjs lives in the SAME staged directory as cli.cjs + graph.json in
  // production (libexec/clode-fuse.cjs's stageDir), but it is clode's OWN
  // source — never escaped — and must never be redirected through the
  // upstream graph just because a graph.json happens to sit beside it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-shim-'));
  try {
    fs.writeFileSync(path.join(dir, 'bun-shim.cjs'), 'require("shim-only-dep");');
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ sources: { '/a.js': 'require("graph-only-dep");' } }));
    assert.deepStrictEqual([...scanBareSpecifiers(path.join(dir, 'bun-shim.cjs'))], ['shim-only-dep']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scannableTexts: a graph.json beside cli.cjs that is not valid JSON fails loud, never silently falls back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-badjson-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.cjs'), '//clode:graph-runner:1\n');
    fs.writeFileSync(path.join(dir, 'graph.json'), '{not valid json');
    assert.throws(() => scanBareSpecifiers(path.join(dir, 'cli.cjs')), /could not be parsed as JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scannableTexts: a graph.json beside cli.cjs with no `sources` map fails loud, never silently falls back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-drift-nosources-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.cjs'), '//clode:graph-runner:1\n');
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ notSources: true }));
    assert.throws(() => scanBareSpecifiers(path.join(dir, 'cli.cjs')), /no `sources` map/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scannableTexts is exported directly and is the mechanism scanBareSpecifiers is built on', () => {
  assert.strictEqual(typeof scannableTexts, 'function');
});

test('isBuiltinSpecifier / specifierPackageName: unit sanity', () => {
  assert.ok(isBuiltinSpecifier('fs'));
  assert.ok(isBuiltinSpecifier('node:sqlite'));
  assert.ok(!isBuiltinSpecifier('sqlite')); // bare form does NOT resolve — must check both directions
  assert.ok(!isBuiltinSpecifier('semver'));
  assert.strictEqual(specifierPackageName('@scope/name/sub/path'), '@scope/name');
  assert.strictEqual(specifierPackageName('pkg/sub/path'), 'pkg');
  assert.strictEqual(specifierPackageName('bun:ffi'), 'bun:ffi');
});

test('shimProvidedModules: reflects libexec/bun-shim.cjs\'s own __bunBuiltins/__hostModules (bun:ffi, bun:sqlite, undici)', () => {
  const provided = shimProvidedModules(LIBEXEC);
  assert.ok(provided.has('bun:ffi'), [...provided].join(', '));
  assert.ok(provided.has('bun:sqlite'), [...provided].join(', '));
  assert.ok(provided.has('undici'), [...provided].join(', '));
  // bun:jsc is genuinely NOT shim-provided (it lives in KNOWN_UNREACHABLE
  // instead, justified by the try/catch around its one call site) — a
  // regression here would silently widen what "provided" means.
  assert.ok(!provided.has('bun:jsc'));
});

// THE PARSE GATE. shimProvidedModules() READS bun-shim.cjs's `const PROVIDES`
// literal out of the source text instead of executing the shim, because
// `clode build` must work on a host with no node: under a fused native builder
// process.execPath is the fused clode itself (see that function's comment for the
// full story). Text and truth can only disagree here if the parse breaks — so
// this asserts the two agree, by EXECUTING the real shim (in a CHILD process:
// requiring it would hook this test runner's own Module._load) and comparing what
// it reports to what the gate read statically.
//
// Reformat PROVIDES into something JSON.parse rejects — single quotes, a comment,
// a trailing comma, a computed value — and this goes red here, in CI, under node,
// rather than in a user's build. Not tautological: one side is a regex+JSON.parse
// over bytes, the other is the module's real exports.
test('PARSE GATE: the statically-read PROVIDES matches what a RUNNING bun-shim reports', () => {
  const script = `const s=require(${JSON.stringify(path.join(LIBEXEC, 'bun-shim.cjs'))});`
    + `process.stdout.write(JSON.stringify([...s.__bunBuiltins,...s.__hostModules]))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `could not execute the real bun-shim: ${r.stderr}`);
  const live = JSON.parse(r.stdout).sort();
  const parsed = [...shimProvidedModules(LIBEXEC)].sort();
  assert.deepStrictEqual(parsed, live,
    'the dep-closure gate reads bun-shim.cjs\'s PROVIDES as TEXT — keep that literal JSON-shaped (double quotes, no comments/trailing commas/expressions)');
});

// The DANGEROUS direction. A name in PROVIDES that the shim does not actually
// intercept is silent: the gate happily excuses cli.cjs's `require("bun:foo")`
// from the ext-dep closure, the build goes green with PONG and attest, and the
// user's quaude throws "Cannot find module" the first time a session reaches it.
// (The reverse — an impl that PROVIDES omits — is fail-safe: the gate would
// demand it from the closure and stop the build loudly.) So prove each declared
// name really resolves THROUGH the shim's Module._load hook, in a child process
// where that hook is installed for real.
test('every name PROVIDES declares is actually intercepted by the shim (declared != implemented)', () => {
  const script = `const s=require(${JSON.stringify(path.join(LIBEXEC, 'bun-shim.cjs'))});`
    + `const bad=[];for(const n of [...s.__bunBuiltins,...s.__hostModules]){`
    + `try{if(require(n)==null)bad.push(n+' (resolved to null)')}catch(e){bad.push(n+' ('+e.code+')')}}`
    + `process.stdout.write(JSON.stringify(bad))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `could not execute the real bun-shim: ${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), [],
    'PROVIDES names a module the shim does not actually resolve — the dep-closure gate would excuse it from the closure and the quaude would throw "Cannot find module" at RUN time');
});

// The gate must not silently pass when it cannot find or parse the declaration —
// a gate that quietly concluded "nothing is shim-provided" would demand bun:ffi
// and bun:sqlite from the ext-dep closure and fail the build for a nonsense
// reason. Every failure names what to fix instead.
test('shimProvidedModules: a missing or non-JSON PROVIDES fails loud and says why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-provides-'));
  assert.throws(() => shimProvidedModules(dir), /cannot read .*bun-shim\.cjs/);
  fs.writeFileSync(path.join(dir, 'bun-shim.cjs'), '// a shim with no declaration\n');
  assert.throws(() => shimProvidedModules(dir), /no 'const PROVIDES = \{\.\.\.\}' declaration/);
  // The exact regression the JSON-shaped contract exists to catch: valid JS,
  // invalid JSON.
  fs.writeFileSync(path.join(dir, 'bun-shim.cjs'), "const PROVIDES = { 'bunBuiltins': ['bun:ffi'], 'hostModules': [] };\n");
  assert.throws(() => shimProvidedModules(dir), /not JSON-shaped/);
  fs.writeFileSync(path.join(dir, 'bun-shim.cjs'), 'const PROVIDES = {"bunBuiltins": "nope", "hostModules": []};\n');
  assert.throws(() => shimProvidedModules(dir), /malformed/);
});

test('GATE: an unknown bare specifier fails the build loud, naming the package and the fix', () => {
  const file = fakeSrcFile('require("totally-unlisted-package");');
  try {
    assert.throws(
      () => assertNoUnknownBareSpecifiers([file], ['semver'], LIBEXEC),
      /'totally-unlisted-package'.*deps\/claude\/package\.json.*KNOWN_UNREACHABLE/s,
    );
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('GATE: a bundle referencing only closure packages + builtins passes clean', () => {
  const file = fakeSrcFile('require("semver");require("fs");require("./local");');
  try {
    assert.doesNotThrow(() => assertNoUnknownBareSpecifiers([file], ['semver'], LIBEXEC));
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('GATE: the KNOWN_UNREACHABLE allowlist is honored (a listed specifier does not fail the build)', () => {
  const file = fakeSrcFile('require("ajv/dist/runtime/uri");');
  try {
    assert.doesNotThrow(() => assertNoUnknownBareSpecifiers([file], [], LIBEXEC));
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('GATE: shim-provided modules (bun:ffi, undici, ...) do not fail the build even though they are not in the closure', () => {
  const file = fakeSrcFile('require("bun:ffi");x=await import("bun:ffi");require("undici");');
  try {
    assert.doesNotThrow(() => assertNoUnknownBareSpecifiers([file], [], LIBEXEC));
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('GATE: a missing file (e.g. bun-shim.cjs not staged) is skipped, not a crash', () => {
  assert.doesNotThrow(() => assertNoUnknownBareSpecifiers(['/nonexistent/cli.cjs'], ['semver'], LIBEXEC));
});

test('KNOWN_UNREACHABLE is a decision record, not a dumping ground: every entry has a concrete, non-empty reason', () => {
  for (const [name, reason] of Object.entries(KNOWN_UNREACHABLE)) {
    assert.strictEqual(typeof reason, 'string', `'${name}' entry must be a string reason`);
    assert.ok(reason.trim().length > 20, `'${name}' entry's reason is too short to be a real justification: ${JSON.stringify(reason)}`);
  }
});

test('GATE (integration): the REAL extracted cli.cjs + bun-shim.cjs, scanned against the REAL closure, passes today', (t) => {
  // The acceptance test for the whole gate: stage the real upstream bundle
  // (test/oracle-models.cjs's stageCli — same layout `clode build` produces:
  // cli.cjs beside bun-shim.cjs) and run the SAME check clode-fuse.cjs runs at
  // build time, with the SAME real closure. A regression here means either a
  // real gap re-opened, or the gate itself would break a real build — the
  // thing the brief calls the acceptance test. Skips (does not fail) when no
  // Bun-packaged provider is available, matching every other provider-gated
  // test in this suite (test/e2e-assets.test.cjs, scripts/apicheck.mjs).
  //
  // Reads staged.cacheDir's cli.cjs, NOT staged.cli (the per-test copy):
  // scannableTexts()'s escape-blind fix (task-11) looks for a graph.json
  // riding BESIDE the cli.cjs it is handed, and stageCli() only ever copies
  // graph.json into cacheDir, never into the per-test dir alongside its cli.cjs
  // copy (test/oracle-models.cjs's stageCli comment). Using staged.cli here
  // would silently re-exercise the OLD escape-blind fallback path instead of
  // the fix — the exact same distinction test/shim-surface.test.cjs's
  // inputs() already draws for the same reason ("Point at the CACHE dir's
  // cli.cjs, not the per-test copy").
  const { stageProviderCli, providerSkipReason } = require('./oracle-models.cjs');
  const staged = stageProviderCli({ env: process.env });
  const skip = providerSkipReason(staged, 'no Bun-packaged CC provider');
  if (skip) { t.skip(skip); return; }
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const closure = computeDepClosure(NM, direct);
  const cachedCli = path.join(staged.cacheDir, 'cli.cjs');
  const cli = fs.existsSync(cachedCli) ? cachedCli : staged.cli;
  assert.doesNotThrow(() => assertNoUnknownBareSpecifiers(
    [cli, path.join(staged.dir, 'bun-shim.cjs')], closure, LIBEXEC));
});

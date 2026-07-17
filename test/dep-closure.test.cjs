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

const REPO = path.resolve(__dirname, '..');
// Claude Code's runtime deps (deps/claude/package.json) — NOT clode's own;
// clode has none (test/clode-self-deps.test.cjs).
const NM = path.join(REPO, 'deps', 'claude', 'node_modules');
const LIBEXEC = path.join(REPO, 'libexec');
const {
  readDirectDeps, computeDepClosure, assertClosureMatchesLockfile,
  scanBareSpecifiers, specifierPackageName, isBuiltinSpecifier, shimProvidedModules,
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

test('scanBareSpecifiers: never scans declarative ESM `from \'...\'` (proven noise on the real bundle — see seed-drift-report.md)', () => {
  // If this regex were included, embedded doc/skill text ("import {x} from 'y'"
  // shown to the model) would produce false positives — including specifiers
  // that are not even valid package names, like `from 'now'` inside a comment
  // on the real bundle. Confirm the scanner does not have this failure mode.
  const file = fakeSrcFile("import { build } from 'esbuild';\nimport { z } from 'zod';\n");
  try {
    assert.deepStrictEqual([...scanBareSpecifiers(file)], []);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
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
  const { stageProviderCli } = require('./oracle-models.cjs');
  const staged = stageProviderCli({ env: process.env });
  if (!staged) { t.skip('no Bun-packaged CC provider'); return; }
  const direct = readDirectDeps(path.join(REPO, 'deps', 'claude', 'package.json'));
  const closure = computeDepClosure(NM, direct);
  assert.doesNotThrow(() => assertNoUnknownBareSpecifiers(
    [staged.cli, path.join(staged.dir, 'bun-shim.cjs')], closure, LIBEXEC));
});

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
const NM = path.join(REPO, 'node_modules');
const { readDirectDeps, computeDepClosure } = require('../libexec/clode-fuse.cjs');

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
  const deps = readDirectDeps(path.join(REPO, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
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
  const direct = readDirectDeps(path.join(REPO, 'package.json'));
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

'use strict';
// PHASE 5B, TASK 2. The dep-closure family (libexec/clode-fuse.cjs) is where phase 5's
// worst defect lived — a gate that decides whether `clode build` embeds every package
// Claude Code's bundle actually references, wrong TWICE: once on escaping (a bare `["']`
// class scanned the escaped `cli.cjs` graph-runner text and produced a set nearly
// disjoint from reality), once on syntax (the fixed scanner still matched only
// require()/import(), missing a declarative `import X from "y"`, of which the pinned
// carve has real occurrences and graph.json's own `externals` independently confirms).
// Both fixes already live in production; this file is the house-shape (defineGuard/
// guardTests, per test/build-gates/lexical-code-mask.test.cjs) that would have caught
// either regressing, plus the positive control phase 5 requires for a guard to count as
// one at all.
//
// The literal relative require below is load-bearing for Task 5's population sweep,
// which derives "which guard controls this production gate" by reading this exact
// string out of the guard's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  scanBareSpecifiers, assertNoUnknownBareSpecifiers, assertClosureMatchesLockfile,
  computeDepClosure, readDirectDeps,
} = require('../../libexec/clode-fuse.cjs');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');
const { pinnedVersion } = require('../provider-resolve.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const LIBEXEC = path.join(REPO, 'libexec');
const NM = path.join(REPO, 'deps', 'claude', 'node_modules');
const PKG_JSON = path.join(REPO, 'deps', 'claude', 'package.json');
const LOCKFILE = path.join(REPO, 'deps', 'claude', 'package-lock.json');

// read() — the only I/O in these guards beyond deps/claude/**: the real pinned carve,
// never ~/.local/share/clode or anything a guard here could write to (nothing does —
// every read() is read-only; every control() writes only to a fixed, overwritten,
// never-deleted path under os.tmpdir(), same tradeoff test/dep-closure.test.cjs's own
// fakeNm()/fakeLockfile() helpers make with mkdtempSync — a synthetic fixture, not a
// real artifact, is the only thing living there).
function pinnedCarveDir() {
  const pin = pinnedVersion();
  return pin ? path.join(os.homedir(), '.cache', 'clode', pin) : null;
}

// ==========================================================================
// GUARD 1 — scanBareSpecifiers: the corpus-wide missed-specifier residual.
// ==========================================================================
//
// scanBareSpecifiers itself never throws and has no "known/unknown" concept of its
// own (that judgment belongs to GUARD 2, below) — it is a pure extractor, so it has
// no violation to detect against the REAL corpus by re-checking its own output.
// What it DOES have, discovered while writing this guard's control (see FIX ROUND 1
// below), is the same STRUCTURAL residual test/build-gates/lexical-code-mask.test.cjs
// models for lexicalCodeMask: a specific source SHAPE that the current, fixed pattern
// set still cannot see, independent of whether today's real corpus happens to trigger
// it (measured: it does not — see the fix's own comment in clode-fuse.cjs).
//
// FIX ROUND 1 (this task, before landing): probing decision #5's literal recipe — "a
// source declaring an unknown bare specifier in BOTH shapes it now covers" — surfaced
// a THIRD shape neither historical fix closes: a side-effect-only declarative import,
// `import "pkg";` (no binding, no `from` clause), is valid ESM and was completely
// invisible to DECLARATIVE_PATTERNS (both existing patterns require `\bfrom\b`).
// Verified live-blind against a synthetic corpus BEFORE fixing (this test file's own
// history — see the git log for this commit); FIXED in libexec/clode-fuse.cjs by
// adding a third DECLARATIVE_PATTERNS entry. The first cut of that fix (a bare
// `\bimport\s+["']([...])["']`) was itself measured to be UNSAFE: scanned against the
// REAL pinned 2.1.251 carve it produced a false positive, `@aws-sdk/credential-
// providers`, from the ENGLISH SENTENCE `` `Failed to import '@aws-sdk/credential-
// providers'.` `` inside a real error-message template literal — the exact
// prose-noise failure class DECLARATIVE_PATTERNS's own file-level comment already
// documents for `assets`. The shipped fix anchors the pattern to a statement boundary
// (start of chunk, or immediately after `;`/`{`/`}`) and requires a trailing `;` —
// verified against both the false positive (rejected) and the genuine case (still
// matched), and the real carve's scanBareSpecifiers(cli) output is unchanged (12
// names, byte-identical to before this round) with the anchoring in place.
//
// That anchoring itself has a residual: a side-effect import relying on ASI (no
// trailing `;`) is not recognised. This guard detects exactly that STRUCTURAL SHAPE —
// `import "pkg"` not immediately followed by `;` — directly over source text,
// independent of scanBareSpecifiers's own output, the same way lexicalCodeMask's own
// guard checks the MASK's structural signature rather than re-deriving "is the final
// answer right".
const UNTERMINATED_SIDE_EFFECT_IMPORT = /(?:^|[;{}])\s*\bimport\s+["']([a-zA-Z0-9_/:@.-]+)["'](?!\s*;)/gm;

// PURE. The shape defineGuard's `scan` requires: {findings, examined}.
function scanUnterminatedSideEffectImports({ chunks }) {
  const findings = [];
  for (const { rel, text } of chunks) {
    if (typeof text !== 'string' || text.length === 0) continue;
    UNTERMINATED_SIDE_EFFECT_IMPORT.lastIndex = 0;
    let m;
    while ((m = UNTERMINATED_SIDE_EFFECT_IMPORT.exec(text))) {
      findings.push(`${rel}: a side-effect-only import '${m[1]}' has no trailing ";" — `
        + `DECLARATIVE_PATTERNS's anchored regex (libexec/clode-fuse.cjs) requires one to `
        + `reject prose ("Failed to import 'x'.") elsewhere in real bundles, so an `
        + `ASI-reliant side-effect import like this one is invisible to scanBareSpecifiers `
        + `and would silently vanish from the ext-dep closure scan.`);
    }
  }
  return { findings, examined: chunks.length };
}

// Real inputs: graph.json's `prelude` + `sources` from the pinned carve — the same
// two chunk kinds scanBareSpecifiers itself treats as declarative-scannable code
// (see scannableTexts()'s comment for why `assets` are excluded from that treatment;
// this guard follows the same exclusion for the same reason — doc/reference TEXT
// reproduces exactly the prose-noise failure mode FIX ROUND 1 above measured).
function readGraphChunks() {
  const dir = pinnedCarveDir();
  if (!dir) {
    return { skip: 'UPSTREAM_PIN has no `claude-code <version>` line — cannot locate the '
      + 'pinned carve to scan' };
  }
  const graphPath = path.join(dir, 'graph.json');
  if (!fs.existsSync(graphPath)) {
    return { skip: `pinned carve not found at ${graphPath} — the local ~/.cache/clode store `
      + 'has not been populated on this box (build once, or run the extractor)' };
  }
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const chunks = [];
  if (typeof g.prelude === 'string') chunks.push({ rel: '<prelude>', text: g.prelude });
  for (const [rel, src] of Object.entries(g.sources || {})) {
    if (typeof src === 'string') chunks.push({ rel, text: src });
  }
  if (chunks.length === 0) return { skip: `graph.json at ${graphPath} has no prelude/sources` };
  return { chunks };
}

// Measured 2026-09-12 against the pinned claude-code 2.1.251 carve:
// `/opt/pkg/bin/node -e '...'` reading graph.json directly counted 1,839 module
// sources + 1 prelude = 1,840 chunks (see task-2-report.md for the exact command).
// The floor is that exact count — a drop means either the carve regenerated with
// fewer modules (the pin moved, and this floor should move with it) or read() broke.
const guard1 = defineGuard({
  name: 'dep-closure-unterminated-side-effect-import',
  floor: 1840,
  read: readGraphChunks,
  scan: scanUnterminatedSideEffectImports,
  control: () => ({
    chunks: [{ rel: 'synthetic/control.cjs', text: 'import "controlled-unterminated-pkg"\nvar x = 1;\n' }],
  }),
});
guardTests(guard1);

test('scanBareSpecifiers genuinely finds a side-effect-only import when it IS terminated (the fix, not just the residual it leaves)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-closure-gate-sideeffect-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.cjs'), '//clode:graph-runner:1\n');
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({
      sources: { '/a.js': 'import "terminated-side-effect-pkg";\nrequire("req-pkg");' },
    }));
    const found = scanBareSpecifiers(path.join(dir, 'cli.cjs'));
    assert.ok(found.has('terminated-side-effect-pkg'),
      `expected 'terminated-side-effect-pkg' among ${[...found].join(', ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the anchored side-effect pattern rejects the real false positive it was measured against (prose quoting a package name)', () => {
  // Transcribed from the real pinned 2.1.251 carve (chunk-rs7rt8dj.js and others) —
  // an error-message template literal, not an import statement.
  const prose = "throw Error(`Failed to import '@aws-sdk/credential-providers'.You can provide a custom`)";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-closure-gate-falsepos-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.cjs'), '//clode:graph-runner:1\n');
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ sources: { '/a.js': prose } }));
    const found = scanBareSpecifiers(path.join(dir, 'cli.cjs'));
    assert.ok(!found.has('@aws-sdk/credential-providers'),
      'the anchored pattern must not mistake prose quoting a package name for a real import statement');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ==========================================================================
// GUARD 2 — assertNoUnknownBareSpecifiers: THE gate that fails a real build.
// ==========================================================================
//
// The control is decision #5's exact recipe: an unknown bare specifier declared in
// BOTH shapes scanBareSpecifiers now covers. A control naming only the require()
// shape would pass against a scanner that silently lost DECLARATIVE_PATTERNS (the
// exact syntax fix this whole family exists because of) and certify a half-blind
// guard — so this checks the thrown message names BOTH specifiers, not merely that
// it throws at all.
function scanUnknownSpecifiers({ files, closure, libexecDir }) {
  const seen = new Set();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const name of scanBareSpecifiers(file)) seen.add(name);
  }
  return throwsAsFindings(assertNoUnknownBareSpecifiers, [files, closure, libexecDir], { examined: seen.size });
}

function readUnknownSpecifiersInputs() {
  const dir = pinnedCarveDir();
  if (!dir) {
    return { skip: 'UPSTREAM_PIN has no `claude-code <version>` line — cannot locate the '
      + 'pinned carve to scan' };
  }
  const cli = path.join(dir, 'cli.cjs');
  if (!fs.existsSync(cli)) {
    return { skip: `pinned carve not found at ${cli} — the local ~/.cache/clode store has `
      + 'not been populated on this box (build once, or run the extractor)' };
  }
  if (!fs.existsSync(NM)) {
    return { skip: `no node_modules at ${NM} — run 'clode build' once or 'npm install' `
      + 'under deps/claude' };
  }
  const closure = computeDepClosure(NM, readDirectDeps(PKG_JSON));
  const shim = path.join(dir, 'bun-shim.cjs');
  const files = [cli, shim].filter((f) => fs.existsSync(f));
  return { files, closure, libexecDir: LIBEXEC };
}

// A fixed (never mkdtemp'd) path, overwritten on every control() call — the fixture
// is synthetic, not a real artifact, so there is nothing to clean up between runs;
// see this file's header comment.
const CONTROL_SPECIFIERS_DIR = path.join(os.tmpdir(), 'clode-dep-closure-guard-control-specifiers');

function unknownSpecifiersControlInputs() {
  // Named literally `cli.cjs` with a `graph.json` beside it — DECLARATIVE_PATTERNS
  // only ever applies to a file scannableTexts() recognises as a graph-runner carve
  // (see its own comment: `path.basename(file) === 'cli.cjs'`), so a differently
  // named fixture would silently fall back to the raw-text path and never exercise
  // the declarative shape at all — the exact mistake this control's first draft
  // made (measured: the control then threw naming ONLY 'controlled-unknown-req').
  fs.mkdirSync(CONTROL_SPECIFIERS_DIR, { recursive: true });
  const file = path.join(CONTROL_SPECIFIERS_DIR, 'cli.cjs');
  fs.writeFileSync(file, '//clode:graph-runner:1\n');
  fs.writeFileSync(path.join(CONTROL_SPECIFIERS_DIR, 'graph.json'), JSON.stringify({
    sources: { '/control.js': 'require("controlled-unknown-req");\nimport X from "controlled-unknown-decl";\n' },
  }));
  return { files: [file], closure: [], libexecDir: LIBEXEC };
}

// Measured 2026-09-12: scanBareSpecifiers over the pinned carve's cli.cjs UNION
// bun-shim.cjs found 16 distinct bare specifiers (12 from cli.cjs + 5 from
// bun-shim.cjs, 1 — 'ws' — shared). See task-2-report.md for the exact command.
const guard2 = defineGuard({
  name: 'dep-closure-unknown-bare-specifiers',
  floor: 16,
  read: readUnknownSpecifiersInputs,
  scan: scanUnknownSpecifiers,
  control: unknownSpecifiersControlInputs,
});
guardTests(guard2);

test('GATE control names BOTH the require() and declarative-import shapes (the syntax fix, not just the escaping fix)', () => {
  const { files, closure, libexecDir } = unknownSpecifiersControlInputs();
  assert.throws(
    () => assertNoUnknownBareSpecifiers(files, closure, libexecDir),
    (e) => {
      assert.match(e.message, /controlled-unknown-req/, 'the require() shape must be named');
      assert.match(e.message, /controlled-unknown-decl/,
        'the declarative import shape must be named — a control covering only require() '
        + 'would pass against a half-blind (pre-syntax-fix) scanner and certify it');
      return true;
    },
  );
});

// ==========================================================================
// GUARD 3 — assertClosureMatchesLockfile: node_modules must match the lockfile.
// ==========================================================================

function scanClosureMatchesLockfile({ closureVersions, lockfilePath }) {
  return throwsAsFindings(assertClosureMatchesLockfile, [closureVersions, lockfilePath], { examined: closureVersions.size });
}

function readLockfileInputs() {
  if (!fs.existsSync(NM)) {
    return { skip: `no node_modules at ${NM} — run 'clode build' once or 'npm install' `
      + 'under deps/claude' };
  }
  if (!fs.existsSync(LOCKFILE)) return { skip: `no lockfile at ${LOCKFILE}` };
  const closureVersions = new Map();
  computeDepClosure(NM, readDirectDeps(PKG_JSON), { versions: closureVersions });
  return { closureVersions, lockfilePath: LOCKFILE };
}

const CONTROL_LOCKFILE_DIR = path.join(os.tmpdir(), 'clode-dep-closure-guard-control-lockfile');

function lockfileControlInputs() {
  fs.mkdirSync(CONTROL_LOCKFILE_DIR, { recursive: true });
  const lockfilePath = path.join(CONTROL_LOCKFILE_DIR, 'package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/controlled-pkg': { version: '1.0.0' } },
  }));
  // node_modules claims 2.0.0; the lockfile pins 1.0.0 — the `npm install` (not
  // `npm ci`) drift assertClosureMatchesLockfile exists to catch.
  return { closureVersions: new Map([['controlled-pkg', '2.0.0']]), lockfilePath };
}

// Measured 2026-09-12: computeDepClosure's versions Map over the real deps/claude
// closure has 18 entries (18 packages, every one resolved to a version). See
// task-2-report.md for the exact command.
const guard3 = defineGuard({
  name: 'dep-closure-matches-lockfile',
  floor: 18,
  read: readLockfileInputs,
  scan: scanClosureMatchesLockfile,
  control: lockfileControlInputs,
});
guardTests(guard3);

// ==========================================================================
// GUARD 4 — computeDepClosure: a dependency that does not reach quaude at all.
// ==========================================================================
// The duplication-audit-§1 regression this whole family replaces, in miniature
// (test/dep-closure.test.cjs's own header comment): a package.json dependency that
// is not actually installed under node_modules must fail the BUILD loud, not surface
// later as a runtime "Cannot find module".

function scanComputeClosure({ nmDir, directDeps }) {
  return throwsAsFindings(computeDepClosure, [nmDir, directDeps], { examined: directDeps.length });
}

function readComputeClosureInputs() {
  if (!fs.existsSync(NM)) {
    return { skip: `no node_modules at ${NM} — run 'clode build' once or 'npm install' `
      + 'under deps/claude' };
  }
  if (!fs.existsSync(PKG_JSON)) return { skip: `no package.json at ${PKG_JSON}` };
  return { nmDir: NM, directDeps: readDirectDeps(PKG_JSON) };
}

const CONTROL_NM_DIR = path.join(os.tmpdir(), 'clode-dep-closure-guard-control-nm');

function computeClosureControlInputs() {
  fs.rmSync(CONTROL_NM_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(CONTROL_NM_DIR, 'present'), { recursive: true });
  fs.writeFileSync(path.join(CONTROL_NM_DIR, 'present', 'package.json'),
    JSON.stringify({ name: 'present', version: '1.0.0' }));
  // 'controlled-missing-dep' is declared as a direct dep but never installed —
  // exactly the shape a `package.json` edit with no matching `npm install` produces.
  return { nmDir: CONTROL_NM_DIR, directDeps: ['present', 'controlled-missing-dep'] };
}

// Measured 2026-09-12: deps/claude/package.json declares 8 direct dependencies
// (buffer, node-fetch, semver, string-width, strip-ansi, wrap-ansi, ws, yaml). See
// task-2-report.md for the exact command.
const guard4 = defineGuard({
  name: 'dep-closure-computed-closure',
  floor: 8,
  read: readComputeClosureInputs,
  scan: scanComputeClosure,
  control: computeClosureControlInputs,
});
guardTests(guard4);

// ==========================================================================
// Step 4: floors fire when the input shrinks below them — one demonstration per
// guard, built directly on guard.cjs's checkGate() (never through the registered,
// frozen guard objects, which cannot be re-floored) with an input deliberately
// smaller than the measured floor above. Synthetic, not derived from the real
// corpus, so these pass on a box with no pinned carve / no node_modules too.
// ==========================================================================

test('floor fires: dep-closure-unterminated-side-effect-import goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-1', floor: guard1.floor,
    read: () => ({ chunks: [{ rel: 'a', text: 'var x = 1;' }] }),
    scan: scanUnterminatedSideEffectImports,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

test('floor fires: dep-closure-unknown-bare-specifiers goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-2', floor: guard2.floor,
    read: () => ({ files: [], closure: [], libexecDir: LIBEXEC }),
    scan: scanUnknownSpecifiers,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

test('floor fires: dep-closure-matches-lockfile goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-3', floor: guard3.floor,
    read: () => ({ closureVersions: new Map(), lockfilePath: LOCKFILE }),
    scan: scanClosureMatchesLockfile,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

test('floor fires: dep-closure-computed-closure goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-4', floor: guard4.floor,
    read: () => ({ nmDir: NM, directDeps: [] }),
    scan: scanComputeClosure,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = {
  scanUnterminatedSideEffectImports, readGraphChunks, guard1,
  scanUnknownSpecifiers, readUnknownSpecifiersInputs, guard2,
  scanClosureMatchesLockfile, readLockfileInputs, guard3,
  scanComputeClosure, readComputeClosureInputs, guard4,
};

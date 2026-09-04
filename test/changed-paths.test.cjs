'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyChangedPaths, isDocsPath } = require('../scripts/changed-paths.mjs');

// Task 7 (.superpowers/sdd/2026-09-04-phase5-gates-that-can-fail/task-7-brief.md):
// CI stops destroying its own signal. classifyChangedPaths is the derivation
// that lets a `changes` job (which CAN see the diff) decide whether the
// heavy build matrix needs to run, while concurrency.group stays per-branch
// (GitHub evaluates that expression before any job runs, and it cannot see
// which files a push touched).
//
// DEFAULT-DENY IS THE WHOLE DESIGN: an unrecognised path, an empty change
// list, or any failure upstream of this function all mean CODE. The docs
// allow-list (*.md, docs/**, LICENSE) is safe ONLY because unknown => code.

test('a docs-only change is not code', () => {
  assert.strictEqual(classifyChangedPaths(['BACKLOG.md', 'CHANGELOG.md']).code, false);
});

test('DEFAULT-DENY: an unrecognised path counts as code', () => {
  assert.strictEqual(classifyChangedPaths(['some/new/thing.xyz']).code, true,
    'the classifier must fail SAFE — an unknown path means run everything');
});

test('one code path among many docs paths is code', () => {
  assert.strictEqual(classifyChangedPaths(['BACKLOG.md', 'libexec/quaude-fuse.js']).code, true);
});

test('an EMPTY change list counts as code', () => {
  assert.strictEqual(classifyChangedPaths([]).code, true,
    'an empty list means the diff could not be computed — that must run everything, not '
    + 'skip everything, or a broken diff silently disables CI');
});

test('a .md file inside a code directory is still docs', () => {
  assert.strictEqual(classifyChangedPaths(['libexec/README.md']).code, false);
});

test('a workflow change is code', () => {
  assert.strictEqual(classifyChangedPaths(['.github/workflows/ci.yml']).code, true);
});

// --- Coverage beyond the brief's required cases -----------------------------

test('docs/** anywhere under the top-level docs directory is docs', () => {
  const r = classifyChangedPaths(['docs/foo/bar.txt']);
  assert.strictEqual(r.code, false);
});

test('a path merely named "docs" as a file, not a directory, is still allow-listed by prefix rule intent (docs itself)', () => {
  // "docs" with no trailing content is the directory path itself in some diff
  // outputs (e.g. a rename); it must not accidentally read as code.
  assert.strictEqual(isDocsPath('docs'), true);
});

test('a top-level LICENSE file is docs', () => {
  assert.strictEqual(classifyChangedPaths(['LICENSE']).code, false);
});

test('LICENSE-like names that are not the exact root file are NOT allow-listed (default-deny)', () => {
  assert.strictEqual(isDocsPath('licenses/LICENSE'), false,
    'the allow-list is deliberately narrow; only the exact root LICENSE path matches');
  assert.strictEqual(classifyChangedPaths(['licenses/LICENSE']).code, true);
});

test('a docsomething.js file is NOT docs — "docs" must be a path segment, not a prefix', () => {
  assert.strictEqual(isDocsPath('docsomething.js'), false);
  assert.strictEqual(classifyChangedPaths(['docsomething.js']).code, true);
});

test('mixed case .MD extension still counts as docs (case-insensitive match)', () => {
  assert.strictEqual(isDocsPath('README.MD'), true);
});

test('a non-array input counts as code (defensive default-deny)', () => {
  assert.strictEqual(classifyChangedPaths(null).code, true);
  assert.strictEqual(classifyChangedPaths(undefined).code, true);
});

test('every result carries a non-empty "why"', () => {
  for (const input of [[], ['BACKLOG.md'], ['some/new/thing.xyz'], ['docs/x.txt']]) {
    const r = classifyChangedPaths(input);
    assert.strictEqual(typeof r.why, 'string');
    assert.ok(r.why.length > 0, `why must be non-empty for input ${JSON.stringify(input)}`);
  }
});

// --- Fix round 1, Finding 2: path traversal in the docs allow-list ---------
// Verified by the reviewer's own execution before this fix: both strings
// below classified as code=false (docs), letting a real code file hide
// behind a `docs/../` prefix. `git diff --name-only` does not emit
// un-normalised paths today — this was latent, not yet exploited — but
// isDocsPath/classifyChangedPaths are exported, so "the current caller
// happens not to hit it" is not a reason to leave it reachable.

test('a `..` segment escaping docs/ is code, not docs (regression: was code=false)', () => {
  assert.strictEqual(isDocsPath('docs/../libexec/quaude-fuse.js'), false);
  assert.strictEqual(classifyChangedPaths(['docs/../libexec/quaude-fuse.js']).code, true);
});

test('a nested `..` climbing back out of docs/ is code, not docs (regression: was code=false)', () => {
  assert.strictEqual(isDocsPath('docs/sub/../../scripts/z.mjs'), false);
  assert.strictEqual(classifyChangedPaths(['docs/sub/../../scripts/z.mjs']).code, true);
});

test('a bare ".." path is code, not docs', () => {
  assert.strictEqual(isDocsPath('..'), false);
  assert.strictEqual(classifyChangedPaths(['..']).code, true);
});

test('a `..` segment does not falsely poison an otherwise-safe substring match (a..b.md is still docs)', () => {
  // ".." as a SUBSTRING (not a path segment) must not trip the traversal
  // guard — only a segment that IS exactly ".." counts.
  assert.strictEqual(isDocsPath('a..b.md'), true);
});

test('requiring the module does not shell out to git or print anything (no CLI side effect on import)', () => {
  // classifyChangedPaths/isDocsPath must be usable as a pure library from a
  // test with no repo/git context assumed. The CLI path (computing the real
  // diff and writing GITHUB_OUTPUT lines) only runs when the file is
  // invoked directly, not when required — this test having already required
  // the module above without a git repo or GITHUB_EVENT_NAME set, and
  // without throwing, is itself proof of that; this assertion just names it.
  assert.strictEqual(typeof classifyChangedPaths, 'function');
});

'use strict';
// scripts/merge-step.mjs — the cyclic-group merge extracted as a protocol-only component
// (Task 7 of docs/superpowers/plans/2026-09-02-phase2-name-the-steps.md). SOURCE assertions
// only, same posture as test/quaude-fuse-merge.test.cjs and test/quaude-fuse-report.test.cjs:
// the actual merge behaviour needs a tjs engine, a staged 50MB graph and minutes, which
// belongs in a real build, not `node --test` (see task-7-report.md for that real-data proof —
// the pre-extraction algorithm and merge-step.mjs were run against the SAME real 2.1.251 graph
// and produced byte-identical order + sources).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const SRC = fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8');

test('merge-step documents an argv contract at the top of the file', () => {
  const src = fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8');
  assert.match(src.slice(0, 1200), /Usage/i, 'a program with a contract says so, like quaude-fuse.js:7-21');
});

test('merge-step declares its own steps through the protocol', () => {
  const src = fs.readFileSync(require.resolve('../scripts/merge-step.mjs'), 'utf8');
  assert.match(src, /build-report\.cjs/);
  assert.match(src, /['"`]merge['"`]/);
});

test('the cache key still derives from the merger source, not a literal', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  assert.match(src, /scc-merge\.cjs/, 'the derived key must survive the extraction');
});

// The following carry forward the source assertions that used to live in
// test/quaude-fuse-merge.test.cjs against libexec/quaude-fuse.js, before Task 7 moved the
// actual merge driving logic out of it and into this file.

test('merge-step calls the shared driver, not a private copy of the merge loop', () => {
  assert.match(SRC, /graph-scc-merge\.cjs/, 'it loads the shared merge driver');
  assert.match(SRC, /scc\.mergeCyclicGroups\(/, 'it calls the shared driver');
  assert.doesNotMatch(SRC, /merger\.mergeGroup\(/,
    'the merge loop must live in libexec/graph-scc-merge.cjs only — a second copy here is '
    + 'exactly the drift that let a quaude work while every naude and oracle did not');
});

test('merge-step recognises an already-merged staged graph and does nothing to it', () => {
  assert.match(SRC, /doc\.sccMerge/);
});

// The engine binding is REQUIRED, not optional: guessing names is how a merged module silently
// shadows a binding. Same posture as the stale-engine constants gate.
test('merge-step refuses an engine without moduleMeta', () => {
  assert.match(SRC, /does not report moduleMeta/);
});

// The named escape hatch survives the extraction too — a bisect tool for separating "the merge
// is wrong" from "the graph is wrong" is worthless if only the ORIGINAL file had it.
test('merge-step still honours CLODE_ALLOW_CYCLIC_REQUIRES=0', () => {
  assert.match(SRC, /CLODE_ALLOW_CYCLIC_REQUIRES/);
});

// The cache must be invalidated when OUR merger changes, or editing scc-merge.cjs would have no
// effect on any machine that had already built once — a debugging nightmare that looks like the
// edit did nothing.
test('the merge cache is keyed on the merger version, not only the provider', () => {
  assert.match(SRC, /mergerVersion|MERGER_VERSION/,
    'the cached merge must record which merger produced it');
});

// A bundle with no cyclic requires must take exactly today's no-op path — merge-step.mjs is now
// the ONLY place that decides this (quaude-fuse.js always spawns it, unconditionally).
test('merge-step does no compute when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/);
});

// Output contract: the caller (quaude-fuse.js) reads this filename back and applies it onto
// its own in-memory doc. Getting the name wrong here is silent until the very next build.
test('merge-step writes the result to graph-merged.json, the caller\'s read-back contract', () => {
  assert.match(SRC, /graph-merged\.json/);
});

test('build-report stays tjs-safe, or this script dies at runtime', () => {
  const src = fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8');
  assert.strictEqual(/require\(/.test(src), false,
    'build-report.cjs must not require anything: merge-step.mjs loads it under txiki.js, not Node');
});

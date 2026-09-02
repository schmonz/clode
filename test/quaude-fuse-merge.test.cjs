'use strict';
// The fuse worker's half of the SCC merge (design memo:
// docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md). These are SOURCE assertions,
// not behavioural ones: the behaviour needs a tjs engine, a staged 50MB graph and minutes,
// which belongs in the acceptance build, not in `node --test`. What a source assertion CAN do
// cheaply is stop the four ways this wiring silently reverts to a no-op.
//
// TASK 7: the merge driver call, the moduleMeta guard and the merger-version cache keying all
// moved OUT of this file and into scripts/merge-step.mjs (a protocol-only component — see
// test/merge-step.test.cjs, which now carries the assertions that used to live here against
// quaude-fuse.js's own source). What stays true of quaude-fuse.js itself is narrower: it
// recognises an already-merged staged graph (so it does not even bother spawning work for it —
// no, it still spawns, but skips applying anything back), it does no merge work when there are
// no cyclic requires, and it reaches the merge ONLY by spawning scripts/merge-step.mjs — never
// by calling the driver directly.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-fuse.js'), 'utf8');

// The merge now happens at STAGING (libexec/clode-extract.cjs) OR, for a doc staged before
// that moved, inside scripts/merge-step.mjs — either way the staged graph both targets consume
// ends up merged before this worker's compile step ever runs.
test('quaude-fuse reaches the merge ONLY by spawning scripts/merge-step.mjs, never by calling the driver itself', () => {
  assert.match(SRC, /merge-step\.mjs/, 'it must spawn the protocol-only merge component');
  assert.match(SRC, /tjs\.spawn\(/, 'the merge is a real subprocess, not an in-process call');
  assert.doesNotMatch(SRC, /scc\.mergeCyclicGroups\(/,
    'the driver call belongs to scripts/merge-step.mjs alone — a second copy (or a direct call) '
    + 'here is exactly the drift that let a quaude work while every naude and oracle did not');
  assert.doesNotMatch(SRC, /merger\.mergeGroup\(/,
    'the merge loop must live in libexec/graph-scc-merge.cjs only');
});

test('quaude-fuse checks how the merge subprocess exited — a killed child is not exit 0', () => {
  assert.match(SRC, /term_signal/, 'tjs reports a killed child\'s signal as a STRING, not null');
  assert.match(SRC, /exit_status/, 'and the exit status must be checked explicitly too');
});

test('quaude-fuse skips applying a merge result when staging already merged the graph', () => {
  assert.match(SRC, /doc\.sccMerge/, 'it must recognise an already-merged staged graph');
});

// A bundle with no cyclic requires must take exactly today's path.
test('quaude-fuse does no merge work when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/);
});

// The two processes' sole shared contract for the merged bytes: the filename. The format/
// version fields INSIDE that file are scripts/merge-step.mjs's alone (see its own tests).
test('quaude-fuse reads the merge result back from the SAME cache filename merge-step.mjs writes', () => {
  assert.match(SRC, /graph-merged\.json/);
});

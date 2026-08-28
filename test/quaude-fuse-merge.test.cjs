'use strict';
// The fuse worker's half of the SCC merge (design memo:
// docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md). These are SOURCE assertions,
// not behavioural ones: the behaviour needs a tjs engine, a staged 50MB graph and ~6 minutes,
// which belongs in the acceptance build, not in `node --test`. What a source assertion CAN do
// cheaply is stop the four ways this wiring silently reverts to a no-op.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-fuse.js'), 'utf8');

test('quaude-fuse merges cyclic groups rather than only warning', () => {
  assert.match(SRC, /mergeGroup/, 'it calls the merger');
  assert.match(SRC, /cyclicGroups/, 'it computes the groups');
});

// The engine binding is REQUIRED, not optional: guessing names is how a merged module silently
// shadows a binding. Same posture as the stale-engine constants gate.
test('quaude-fuse refuses an engine without moduleMeta', () => {
  assert.match(SRC, /does not report moduleMeta/);
});

// A bundle with no cyclic requires must take exactly today's path.
test('quaude-fuse does no merge work when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/);
});

// The cache must be invalidated when OUR merger changes, or editing scc-merge.cjs would have no
// effect on any machine that had already built once — a debugging nightmare that looks like the
// edit did nothing.
test('the merge cache is keyed on the merger version, not only the provider', () => {
  assert.match(SRC, /mergerVersion|MERGER_VERSION/,
    'the cached merge must record which merger produced it');
});

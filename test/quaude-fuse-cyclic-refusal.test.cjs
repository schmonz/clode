'use strict';
// TASK 7: the named escape hatch (CLODE_ALLOW_CYCLIC_REQUIRES) is read where the refusal
// actually happens now — scripts/merge-step.mjs, the protocol-only component quaude-fuse.js
// spawns to do the merge — not in quaude-fuse.js itself. quaude-fuse.js still reads
// cyclicRequires (to size the spawn's declared total and to no-op when there are none).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-fuse.js'), 'utf8');
const MERGE_STEP_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'merge-step.mjs'), 'utf8');

test('quaude-fuse reads cyclicRequires to size the merge it spawns', () => {
  assert.match(SRC, /cyclicRequires/, 'the fuse worker reads the residual edges');
});

test('scripts/merge-step.mjs names the residual edges and has a named escape hatch rather than a silent tolerance', () => {
  assert.match(MERGE_STEP_SRC, /cyclicRequires/, 'it reads the residual edges');
  assert.match(MERGE_STEP_SRC, /CLODE_ALLOW_CYCLIC_REQUIRES/,
    'there is a named escape hatch rather than a silent tolerance');
});

// A bundle with no cyclic requires must take exactly today's path.
test('quaude-fuse does nothing when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/,
    'absent and empty must be the same, and both must be a no-op');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-fuse.js'), 'utf8');

test('quaude-fuse reads cyclicRequires and names them when refusing', () => {
  assert.match(SRC, /cyclicRequires/, 'the fuse worker reads the residual edges');
  assert.match(SRC, /CLODE_ALLOW_CYCLIC_REQUIRES/,
    'there is a named escape hatch rather than a silent tolerance');
});

// A bundle with no cyclic requires must take exactly today's path.
test('quaude-fuse does nothing when there are no cyclic requires', () => {
  assert.match(SRC, /cyclicRequires\s*\|\|\s*\[\]/,
    'absent and empty must be the same, and both must be a no-op');
});

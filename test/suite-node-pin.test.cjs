'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nodePinVerdict } = require('./suite-node-pin.cjs');

test('the pinned node passes', () => assert.strictEqual(nodePinVerdict('nodejs 24.22.0\n', 'v24.22.0'), null));
test('another node is refused, naming both, the 2026-11-24 row', () => {
  const r = nodePinVerdict('nodejs 24.22.0\n', 'v24.21.0');
  assert.match(r, /node v24\.21\.0/); assert.match(r, /pins 24\.22\.0/);
});
test('a stated reason runs anyway; a blank one does not', () => {
  assert.strictEqual(nodePinVerdict('nodejs 24.22.0\n', 'v26.3.0', 'probing node 26'), null);
  assert.notStrictEqual(nodePinVerdict('nodejs 24.22.0\n', 'v26.3.0', '  '), null);
});
test('no nodejs line is a refusal, not a pass', () => assert.match(nodePinVerdict('python 3.12\n', 'v24.22.0'), /names no nodejs/));

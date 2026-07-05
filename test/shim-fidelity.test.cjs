'use strict';
// Layer 1 of the shim-fidelity guard: a characterization snapshot. Any change in the
// output of the six Bun-backing deps over the fixed corpus (e.g. a Renovate bump) fails
// this test. On an INTENTIONAL change, re-bless with: node test/update-shim-fidelity.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const { compute } = require('./shim-fidelity-lib.cjs');
const GOLDEN = require('./shim-fidelity.json');

test('shim fidelity: dep behavior matches the committed snapshot', () => {
  // JSON round-trip so the live compute() is compared apples-to-apples with the parsed
  // golden (same value shapes; no prototype/undefined surprises).
  const actual = JSON.parse(JSON.stringify(compute()));
  assert.deepStrictEqual(actual, GOLDEN);
});

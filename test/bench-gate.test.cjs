'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkRegressions } = require('../bench/lib/gate.cjs');

test('flags a scenario slower than tolerance', () => {
  const { ok, regressions } = checkRegressions({
    baseline: { a: 100, b: 200 },
    current: { a: 130, b: 205 },
    tolerance: 1.25,
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(regressions.length, 1);
  assert.strictEqual(regressions[0].name, 'a');
  assert.ok(Math.abs(regressions[0].factor - 1.3) < 1e-9);
});

test('passes when all within tolerance', () => {
  const { ok, regressions } = checkRegressions({
    baseline: { a: 100 },
    current: { a: 120 },
    tolerance: 1.25,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(regressions.length, 0);
});

test('ignores scenarios missing from baseline', () => {
  const { ok } = checkRegressions({ baseline: {}, current: { new: 999 }, tolerance: 1.25 });
  assert.strictEqual(ok, true);
});

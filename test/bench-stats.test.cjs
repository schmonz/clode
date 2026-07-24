'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarize, ratio, classify, WATCH_AT, HOT_AT } = require('../bench/lib/stats.cjs');

test('summarize returns min/median/p90 over sorted samples', () => {
  const s = summarize([50, 10, 30, 20, 40]);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.median, 30);
  assert.strictEqual(s.p90, 50); // ceil(0.9*5)=5th value (1-indexed)
});

test('summarize throws on empty input', () => {
  assert.throws(() => summarize([]), /no samples/);
});

test('ratio divides a by b', () => {
  assert.strictEqual(ratio(150, 30), 5);
});

test('classify buckets by threshold', () => {
  assert.strictEqual(classify(1.5), 'OK');
  assert.strictEqual(classify(WATCH_AT), 'WATCH');
  assert.strictEqual(classify(9), 'WATCH');
  assert.strictEqual(classify(HOT_AT), 'HOT');
  assert.strictEqual(classify(40), 'HOT');
});

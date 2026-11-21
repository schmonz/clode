'use strict';
// shape-census.test.cjs — the instrument's own tests (observability Task 4): test/shape-census.cjs's census() and
// rngBias() can fail, on the exact defects they exist for, and pass a sound generator.
const { test } = require('node:test');
const assert = require('node:assert');
const { census, rngBias, firstSighting, intRng, mulberry32 } = require('./shape-census.cjs');

// The generators this suite really had (measured 2026-11-19), as factories: rnd(m) -> [0, m).
const FLOAT_LCG_LOW = () => { let s = 20261003; return (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; }; };
const FLOAT_LCG_HIGH = () => { let s = 20261003; return (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 12) % n; }; };
const IMUL_LCG_HIGH = () => { let s = 20261003; return (n) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 16) % n; }; };
const ALTERNATING = () => { let k = 0; return (n) => (k++) % n; };

test('rngBias: the low bits of an LCG fail (rnd(2) alternates: uniform singles, impossible pairs)', () => {
  const r = rngBias('alt', ALTERNATING, [2]);
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /rnd\(2\) is serially correlated: .* 2 of 4 pairs never drawn/);
  assert.ok(rngBias('low', FLOAT_LCG_LOW, [2, 4, 10]).findings.length >= 3);
});

test('rngBias: the float-rounded LCG fails even through its high bits; Math.imul with the high bits and intRng pass', () => {
  assert.ok(rngBias('float-high', FLOAT_LCG_HIGH, [2, 4, 8]).findings.length >= 3);
  const M = [2, 3, 4, 5, 7, 8, 9, 10, 12, 16, 19, 35, 37, 39, 74, 400];
  assert.deepStrictEqual(rngBias('imul-high', IMUL_LCG_HIGH, M).findings, []);
  assert.deepStrictEqual(rngBias('intRng', () => intRng(1), M).findings, []);
});

test('rngBias: an out-of-range value and an undeclared modulus list are findings', () => {
  assert.match(rngBias('bad', () => () => 5, [3]).findings[0], /returned 5, outside \[0, 3\)/);
  assert.match(rngBias('none', () => intRng(1), []).findings[0], /no moduli/);
});

test('census: a shape under its floor is named with its count, floor and reason; a floor or reason left out is a finding', () => {
  const shapes = [{ shape: 'even', min: 3, why: 'three of them', has: (x) => x % 2 === 0 }, { shape: 'big', min: 1, why: 'one', has: (x) => (x > 2 ? 2 : 0) }];
  const r = census('n', shapes, [1, 2, 3]);
  assert.deepStrictEqual(r.counts, { even: 1, big: 2 });
  assert.deepStrictEqual(r.findings, ['n: shape "even" appeared 1 time(s) in 3 sample(s); its floor is 3 (three of them)']);
  assert.match(census('n', [{ shape: 'a', has: () => true, why: 'x' }], [1]).findings[0], /has no floor/);
  assert.match(census('n', [{ shape: 'a', has: () => true, min: 1 }], [1]).findings[0], /does not say why/);
  assert.match(census('n', [], [1]).findings[0], /no shapes declared/);
  assert.match(census('n', shapes, []).findings[0], /examined no samples/);
});

test('firstSighting: a generator caught in a cycle shows as few distinct inputs', () => {
  const r = census('cyc', [{ shape: 'distinct', min: 90, why: 'most of 100', has: firstSighting((x) => x) }], Array.from({ length: 100 }, (_, i) => i % 7));
  assert.strictEqual(r.counts.distinct, 7);
  assert.strictEqual(r.findings.length, 1);
});

test('mulberry32 is the function the lead-scrub corpus held inline (retired 2026-11-21 with its hook)', () => {
  let seed = 20260927;
  const inline = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const f = mulberry32(20260927);
  for (let i = 0; i < 1000; i++) assert.strictEqual(f(), inline());
});


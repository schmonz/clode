// test/semver.test.cjs — Bun.semver shim: numeric order + range satisfies.
const { test } = require('node:test');
const assert = require('node:assert');
const { semver } = require('../libexec/bun-shim.cjs');

test('order: multi-digit components compare numerically, not lexically', () => {
  // the Remote Control gate bug: "2.1.179" must be GREATER than "2.1.70"
  assert.strictEqual(semver.order('2.1.179', '2.1.70'), 1);
  assert.strictEqual(semver.order('2.1.70', '2.1.179'), -1);
  assert.strictEqual(semver.order('2.1.179', '2.1.179'), 0);
});

test('order: major/minor/patch precedence and v-prefix/partial tolerance', () => {
  assert.strictEqual(semver.order('1.0.0', '2.0.0'), -1);
  assert.strictEqual(semver.order('1.2.0', '1.1.9'), 1);
  assert.strictEqual(semver.order('v2.1.0', '2.1.0'), 0);
  assert.strictEqual(semver.order('2.1', '2.1.0'), 0);   // missing parts = 0
});

test('order: prerelease ranks below release, by SemVer §11', () => {
  assert.strictEqual(semver.order('1.0.0-alpha', '1.0.0'), -1);
  assert.strictEqual(semver.order('1.0.0', '1.0.0-alpha'), 1);
  assert.strictEqual(semver.order('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
  assert.strictEqual(semver.order('1.0.0-alpha', '1.0.0-alpha.1'), -1); // fewer fields < more
  assert.strictEqual(semver.order('1.0.0-1', '1.0.0-alpha'), -1);       // numeric < alnum
});

test('the gate helpers built on order now pass for a newer build', () => {
  // XE(v,min) = order>=0 ("at least"), _e(v,min) = order===-1 ("too old")
  const atLeast = (v, min) => semver.order(v, min) >= 0;
  const tooOld = (v, min) => semver.order(v, min) === -1;
  assert.strictEqual(atLeast('2.1.179', '2.1.70'), true);
  assert.strictEqual(tooOld('2.1.179', '2.1.70'), false);   // was true under string compare
  assert.strictEqual(tooOld('2.1.69', '2.1.70'), true);
});

test('satisfies: exact, comparators, and partials', () => {
  assert.strictEqual(semver.satisfies('2.1.179', '>=2.1.70'), true);
  assert.strictEqual(semver.satisfies('2.1.69', '>=2.1.70'), false);
  assert.strictEqual(semver.satisfies('2.1.179', '2.1.179'), true);
  assert.strictEqual(semver.satisfies('2.1.179', '2.1.70'), false); // exact, not range
  assert.strictEqual(semver.satisfies('2.1.179', '>=2.1'), true);   // padded partial
  assert.strictEqual(semver.satisfies('1.9.9', '<2.0.0'), true);
});

test('satisfies: caret, tilde, x-ranges, hyphen, OR', () => {
  assert.strictEqual(semver.satisfies('1.4.0', '^1.2.0'), true);
  assert.strictEqual(semver.satisfies('2.0.0', '^1.2.0'), false);
  assert.strictEqual(semver.satisfies('1.2.9', '~1.2.0'), true);
  assert.strictEqual(semver.satisfies('1.3.0', '~1.2.0'), false);
  assert.strictEqual(semver.satisfies('1.5.2', '1.x'), true);
  assert.strictEqual(semver.satisfies('2.0.0', '1.x'), false);
  assert.strictEqual(semver.satisfies('1.2.3', '1.2.0 - 1.3.0'), true);
  assert.strictEqual(semver.satisfies('1.4.0', '1.2.0 - 1.3.0'), false);
  assert.strictEqual(semver.satisfies('3.0.0', '^1.0.0 || ^3.0.0'), true);
  assert.strictEqual(semver.satisfies('*', '*'), true);
  assert.strictEqual(semver.satisfies('9.9.9', '*'), true);
});

test('satisfies: AND of comparators (range intersection)', () => {
  assert.strictEqual(semver.satisfies('2.1.179', '>=2.1.70 <3.0.0'), true);
  assert.strictEqual(semver.satisfies('3.0.1', '>=2.1.70 <3.0.0'), false);
});

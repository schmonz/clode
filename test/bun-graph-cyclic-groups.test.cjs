'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cyclicGroups } = require('../libexec/bun-graph-plan.cjs');

// The groups are computed over the POST-CONVERSION graph: static imports, plus the safe edges
// that will become static imports, plus the cyclic ones that cannot. A group that only exists
// because of a safe edge still has to be merged, because that edge is real after conversion.
test('cyclicGroups: a cycle closed by a cyclic require is a group', () => {
  const mods = new Map([
    ['/g/a.js', 'import { x } from "/g/b.js"; export const y = x;'],
    ['/g/b.js', 'export const x = import.meta.require("/g/a.js").y;'],
  ]);
  assert.deepStrictEqual(cyclicGroups(mods), [['/g/a.js', '/g/b.js']]);
});

test('cyclicGroups: an acyclic graph has no groups', () => {
  const mods = new Map([
    ['/g/a.js', 'import { x } from "/g/b.js"; export const y = x;'],
    ['/g/b.js', 'export const x = 1;'],
  ]);
  assert.deepStrictEqual(cyclicGroups(mods), []);
});

test('cyclicGroups: a lone module requiring itself is NOT a group', () => {
  // Single-member components are excluded — there is nothing to merge with.
  const mods = new Map([['/g/a.js', 'export const y = import.meta.require("/g/a.js");']]);
  assert.deepStrictEqual(cyclicGroups(mods), []);
});

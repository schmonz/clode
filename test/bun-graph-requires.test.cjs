'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { requiresOf, classifyRequires } = require('../libexec/bun-graph-plan.cjs');

test('requiresOf: both quote styles, deduped, in-graph targets only', () => {
  const inGraph = (s) => s === '/g/b.js';
  assert.deepStrictEqual(
    requiresOf('require("/g/b.js"); require(\'/g/b.js\'); require("node:fs");', inGraph),
    ['/g/b.js']);
});

// The common case, and the one that breaks CI: a require whose target does NOT lead back to
// the requirer. Converting it to a static import creates no cycle, so the engine can resolve
// it natively and the module is evaluated before it is needed.
test('classifyRequires: a require with no path back is SAFE', () => {
  const mods = new Map([
    ['/g/a.js', 'export const y = require("/g/b.js").x;'],
    ['/g/b.js', 'export const x = 1;'],
  ]);
  const c = classifyRequires(mods);
  assert.deepStrictEqual(c.safe, [['/g/a.js', '/g/b.js']]);
  assert.deepStrictEqual(c.cyclic, []);
});

// The rarer case: the target statically imports its way back to the requirer, so a static
// import would close a cycle and planOrder would reject the whole graph.
test('classifyRequires: a require whose target imports back is CYCLIC', () => {
  const mods = new Map([
    ['/g/a.js', 'export const y = require("/g/b.js").x;'],
    ['/g/b.js', 'import { y } from "/g/a.js"; export const x = y;'],
  ]);
  const c = classifyRequires(mods);
  assert.deepStrictEqual(c.cyclic, [['/g/a.js', '/g/b.js']]);
  assert.deepStrictEqual(c.safe, []);
});

test('classifyRequires: requires pointing outside the graph are ignored entirely', () => {
  const mods = new Map([['/g/a.js', 'const fs = require("node:fs"); export const y = 1;']]);
  assert.deepStrictEqual(classifyRequires(mods), { safe: [], cyclic: [] });
});

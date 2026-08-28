'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeGroup, declaredNames } = require('../libexec/scc-merge.cjs');

const META = {
  '/g/a.js': { requires: ['/g/b.js'], exports: ['ay'], locals: ['shared', 'ay', '<class_fields_init>'] },
  '/g/b.js': { requires: ['/g/a.js'], exports: ['bx'], locals: ['shared', 'bx', 'shared'] },
};
const SRC = {
  '/g/a.js': 'const shared = 1;\nexport const ay = shared;\n',
  '/g/b.js': 'const shared = 2;\nexport const bx = shared + import.meta.require("/g/a.js").ay;\n',
};
const meta = (n) => META[n];

// moduleMeta returns names from two engine tables, so duplicates and compiler-internal names
// in angle brackets both occur. Neither is a user binding.
test('declaredNames dedupes and drops compiler-internal names', () => {
  assert.deepStrictEqual([...declaredNames(META['/g/a.js'])].sort(), ['ay', 'shared']);
  assert.deepStrictEqual([...declaredNames(META['/g/b.js'])].sort(), ['bx', 'shared']);
});

test('mergeGroup names the merged module deterministically', () => {
  assert.strictEqual(mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0).mergedName,
    '/$bunfs/root/__clode-scc-0.js');
});

// `shared` collides across both members. Each must get its own binding or one silently
// shadows the other — a merge that boots and computes the wrong answer.
test('mergeGroup renames only the names that actually collide', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.match(r.mergedSource, /__m0_shared/);
  assert.match(r.mergedSource, /__m1_shared/);
  assert.doesNotMatch(r.mergedSource, /\bconst shared\b/);
  // `ay` and `bx` do not collide, so they must be left alone.
  assert.doesNotMatch(r.mergedSource, /__m0_ay|__m1_bx/);
});

// The intra-group require is now a same-scope reference: no require may survive inside a merge.
test('mergeGroup turns an intra-group require into a direct reference', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.doesNotMatch(r.mergedSource, /import\.meta\.require\("\/g\/a\.js"\)/);
  assert.doesNotMatch(r.mergedSource, /require\("\/g\/a\.js"\)/);
});

test('mergeGroup emits one re-export shim per member, keyed by member name', () => {
  const r = mergeGroup(['/g/a.js', '/g/b.js'], SRC, meta, 0);
  assert.deepStrictEqual(Object.keys(r.shims).sort(), ['/g/a.js', '/g/b.js']);
  assert.match(r.shims['/g/a.js'], /\bay\b/);
  assert.match(r.shims['/g/a.js'], /from "\/\$bunfs\/root\/__clode-scc-0\.js"/);
});

test('mergeGroup REFUSES when a member has no metadata', () => {
  assert.throws(() => mergeGroup(['/g/a.js', '/g/zz.js'], SRC, meta, 0),
    /scc-merge: no metadata for \/g\/zz\.js/);
});

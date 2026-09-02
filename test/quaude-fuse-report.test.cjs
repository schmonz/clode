'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const R = require('../libexec/build-report.cjs');

test('quaude-fuse LOADS the protocol module the way it loads its other libexec cjs', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  assert.match(src, /build-report\.cjs/, 'the worker must speak the protocol');
  assert.match(src, /Reporter/, 'and emit through it rather than ad-hoc printing');
  // require() in this worker is a loud stub that throws (:72-81) — there is no
  // module resolver. It must go through loadLibexecCjs, like scc-merge.cjs does.
  assert.match(src, /loadLibexecCjs\(\s*[\s\S]{0,200}build-report\.cjs/,
    'build-report.cjs must be loaded via loadLibexecCjs, not require()');
});

test('build-report.cjs is CARRIED into a fused builder, or it works from a checkout and dies fused', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  // lastIndexOf, not indexOf: 'scc-merge.cjs' appears TWICE earlier too (the loadLibexecCjs
  // call inside mergeCyclicGroups that reads and evaluates it) — indexOf would anchor on
  // that unrelated call instead of the carried-member list this test actually means to check.
  // The carried-member array (":294" in the brief) is where the literal appears LAST.
  const anchor = src.lastIndexOf("'scc-merge.cjs'");
  const members = src.slice(anchor - 400, anchor + 200);
  assert.match(members, /build-report\.cjs/,
    'add it to the carried-member list beside scc-merge.cjs (:294)');
});

test('the worker declares compile, assets and merge as named steps', () => {
  const src = fs.readFileSync(require.resolve('../libexec/quaude-fuse.js'), 'utf8');
  for (const name of ['compile', 'assets', 'merge']) {
    assert.match(src, new RegExp(`['"\`]${name}['"\`]`), `step '${name}' must be declared by name`);
  }
});

test('build-report stays tjs-safe, or the worker dies at runtime', () => {
  const src = fs.readFileSync(require.resolve('../libexec/build-report.cjs'), 'utf8');
  assert.strictEqual(/require\(/.test(src), false,
    'build-report.cjs must not require anything: quaude-fuse.js loads it under txiki.js, not Node');
});

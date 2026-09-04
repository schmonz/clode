'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAllowList } = require('./allow-list.cjs');

test('an entry with no `because` is a finding', () => {
  const r = resolveAllowList([{ pattern: 'build/bundle', provenBy: () => true }]);
  assert.match(r.findings.join('\n'), /because/);
});

test('an exemption for a writer that does not exist is a finding', () => {
  // THE phase-2 defect, made inexpressible. run.mjs exempted
  // REAL_STORE/build-trace.jsonl in Task 3, BEFORE the Task 5 writer existed. From the
  // moment the writer landed every leak was pre-authorised: ten sites leaked into the
  // operator's real ~/.local/share/clode across three rounds with the guard silent,
  // because we had told it to be.
  const r = resolveAllowList([
    { pattern: 'build/future', because: 'the thing that will write here', provenBy: () => false },
  ]);
  assert.match(r.findings.join('\n'), /does not exist|not reachable/i);
  assert.ok(!r.patterns.includes('build/future'),
    'an unproven exemption must NOT be applied — otherwise it still silences the guard');
});

test('a proven, explained entry yields its pattern and no findings', () => {
  const r = resolveAllowList([
    { pattern: '.git', because: 'git refreshes its own index on read-only commands', provenBy: () => true },
  ]);
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.patterns, ['.git']);
});

test('a provenBy that throws is a finding, not a silent pass', () => {
  const r = resolveAllowList([
    { pattern: 'x', because: 'y', provenBy: () => { throw new Error('boom'); } },
  ]);
  assert.match(r.findings.join('\n'), /boom/);
  assert.ok(!r.patterns.includes('x'));
});

test('plain strings are refused outright', () => {
  assert.throws(() => resolveAllowList(['build/bundle']), /record/i);
});

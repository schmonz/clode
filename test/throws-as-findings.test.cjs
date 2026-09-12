'use strict';
// Coverage for test/throws-as-findings.cjs — the adapter every build-gate guard that
// controls a THROWING gate runs through. Both behaviours proven here were added in phase
// 5b's fix round 2 and both exist to stop a control certifying itself on something that is
// not a detection:
//   `expect`   — a crash (changed signature, TypeError) is not a refusal.
//   `examined` as a thunk — count the work the gate DID, not the input it was handed.
// Every fixture here is built in-line: no files, no repo paths, no I/O of any kind.
const { test } = require('node:test');
const assert = require('node:assert');
const { throwsAsFindings } = require('./throws-as-findings.cjs');

test('a gate that does not throw produces no findings, and reports what it examined', () => {
  assert.deepStrictEqual(throwsAsFindings(() => {}, [], { examined: 7 }),
    { findings: [], examined: 7 });
});

test('the existing 3-arg form (integer `examined`, no `expect`) still reports ANY throw', () => {
  const r = throwsAsFindings(() => { throw new Error('anything at all'); }, [], { examined: 3 });
  assert.deepStrictEqual(r, { findings: ['anything at all'], examined: 3 });
});

test('`examined` must be supplied, and must be a non-negative integer', () => {
  assert.throws(() => throwsAsFindings(() => {}, [], {}), /integer `examined`/);
  assert.throws(() => throwsAsFindings(() => {}, [], { examined: -1 }), /integer `examined`/);
  assert.throws(() => throwsAsFindings(() => {}, [], { examined: 1.5 }), /integer `examined`/);
});

test('`expect` lets the real refusal through as a finding', () => {
  const r = throwsAsFindings(() => { throw new Error('ext-dep closure: nope'); }, [],
    { examined: 1, expect: /^ext-dep closure: / });
  assert.deepStrictEqual(r, { findings: ['ext-dep closure: nope'], examined: 1 });
});

test('`expect` RE-RAISES a throw that is not the refusal — a crash is not a detection', () => {
  // THE POINT OF THE PARAMETER. Without it this TypeError would have been reported as a
  // finding, and checkControl() would have certified "the guard can fail" on the strength
  // of the gate CRASHING — while the refusal it claims to control might no longer fire.
  assert.throws(
    () => throwsAsFindings(() => { throw new TypeError('x is not a function'); }, [],
      { examined: 1, expect: /^ext-dep closure: / }),
    (e) => {
      assert.match(e.message, /A crash is not a detection/);
      assert.match(e.message, /x is not a function/, 'the real thrown message must be named');
      assert.match(e.message, /ext-dep closure/, 'the expected refusal must be named too');
      return true;
    },
  );
});

test('`expect` must be a RegExp', () => {
  assert.throws(() => throwsAsFindings(() => {}, [], { examined: 1, expect: 'ext-dep' }),
    /`expect` must be a RegExp/);
});

test('an `examined` thunk counts the work the gate DID, not the input it was handed', () => {
  // The dep-closure GUARD 4 shape in miniature: the gate fills a collection as it walks.
  // The integer form would have to be the INPUT length (2) either way, so a gate that
  // walked nothing would report the same number as one that walked everything.
  const walked = [];
  const gate = (items) => { for (const i of items) walked.push(i); };
  const r = throwsAsFindings(gate, [['a', 'b', 'c']], { examined: () => walked.length });
  assert.deepStrictEqual(r, { findings: [], examined: 3 });
});

test('an `examined` thunk is evaluated AFTER the gate throws, not before', () => {
  const walked = [];
  const gate = () => { walked.push('one'); throw new Error('refused'); };
  const r = throwsAsFindings(gate, [], { examined: () => walked.length });
  assert.deepStrictEqual(r, { findings: ['refused'], examined: 1 },
    'a thunk read before the call would report 0 and make a real refusal look BROKEN');
});

test('an `examined` thunk that returns a non-integer is an error, not a silent 0', () => {
  assert.throws(() => throwsAsFindings(() => {}, [], { examined: () => null }),
    /thunk returned/);
});

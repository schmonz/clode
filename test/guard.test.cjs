'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const G = require('./guard.cjs');

function makeGuard(over = {}) {
  return Object.assign({
    name: `g-${Math.random().toString(36).slice(2)}`,
    read: () => ({ text: 'clean' }),
    scan: (i) => ({
      findings: i.text.includes('BAD') ? ['found BAD'] : [],
      examined: i.text.length,
    }),
    control: () => ({ text: 'BAD' }),
  }, over);
}

test('defineGuard REFUSES a registration with no control', () => {
  assert.throws(() => G.defineGuard(makeGuard({ control: undefined })),
    /control/,
    'a guard with no positive control must not be constructible');
});

test('defineGuard refuses a control that is not callable', () => {
  assert.throws(() => G.defineGuard(makeGuard({ control: 'nope' })), /control/);
});

test('a guard whose control produces no findings is CANNOT_FAIL', () => {
  const g = G.defineGuard(makeGuard({ control: () => ({ text: 'also clean' }) }));
  const r = G.checkControl(g);
  assert.strictEqual(r.verdict, G.CANNOT_FAIL);
  assert.match(r.message, /cannot fail/i);
});

test('a guard whose control produces findings passes the control check', () => {
  const r = G.checkControl(G.defineGuard(makeGuard()));
  assert.strictEqual(r.verdict, G.OK);
});

test('the gate reports VIOLATION when the real artifact has findings', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ text: 'this is BAD' }) }));
  const r = G.checkGate(g);
  assert.strictEqual(r.verdict, G.VIOLATION);
  assert.deepStrictEqual(r.findings, ['found BAD']);
});

test('examined below the floor is BROKEN, NOT a clean pass', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ text: '' }) }));
  const r = G.checkGate(g);
  assert.strictEqual(r.verdict, G.BROKEN,
    'examined 0 means the guard inspected nothing — that is broken, not clean');
  assert.match(r.message, /examined 0/);
  assert.doesNotMatch(r.message, /no findings/i,
    'BROKEN must not read like a clean result');
});

test('an explicit floor above 1 is honoured', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ text: 'abc' }), floor: 100 }));
  assert.strictEqual(G.checkGate(g).verdict, G.BROKEN);
});

test('read() may declare its precondition absent, and the gate SKIPS with that reason', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ skip: 'no provider staged on this host' }) }));
  const r = G.checkGate(g);
  assert.strictEqual(r.verdict, 'SKIP');
  assert.match(r.message, /no provider staged/);
});

test('the control still runs when the real artifact is unavailable', () => {
  // The whole point: a host with no provider can still prove the guard can fail.
  const g = G.defineGuard(makeGuard({ read: () => ({ skip: 'unavailable' }) }));
  assert.strictEqual(G.checkControl(g).verdict, G.OK);
});

test('a scan returning a malformed result is BROKEN, not silently zero', () => {
  const g = G.defineGuard(makeGuard({ scan: () => ({ findings: ['x'] }) })); // no examined
  assert.throws(() => G.checkGate(g), /examined/);
});

test('duplicate guard names are refused', () => {
  const spec = makeGuard({ name: 'dup-name-fixed' });
  G.defineGuard(spec);
  assert.throws(() => G.defineGuard(makeGuard({ name: 'dup-name-fixed' })), /duplicate/);
});

// --- fix round 1 -----------------------------------------------------------

// Finding 1: registered() must not leak a mutable handle. Reassigning `control` on the
// object registered() (or defineGuard's own return value) hands back must not silently
// disarm the guard's positive control.
test('a guard object returned by defineGuard/registered() is frozen: reassigning control throws and does not change the verdict', () => {
  const name = `frozen-${Math.random().toString(36).slice(2)}`;
  G.defineGuard(makeGuard({ name }));
  const g = G.registered().find((x) => x.name === name);
  assert.ok(g, 'registered() must include the guard just defined');
  assert.throws(() => { g.control = () => ({ text: 'also clean' }); }, TypeError,
    'assigning to a property of a frozen guard must throw in strict mode');
  assert.strictEqual(G.checkControl(g).verdict, G.OK,
    'the control must still be the original, working one after the failed reassignment');
});

// Finding 2: read() falsy-but-present skip values must be refused by name, not silently
// fall through into scan() (which then crashes on whatever shape `{ skip: '' }` happens
// to have as far as scan() is concerned).
test('read() returning an empty-string skip is refused, not silently treated as present-and-truthy', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ skip: '' }) }));
  assert.throws(() => G.checkGate(g), /skip/i);
});

test('read() returning a non-string skip is refused', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ skip: false }) }));
  assert.throws(() => G.checkGate(g), /skip/i);
});

test('read() returning a proper { skip: reason } still works after the key-presence fix', () => {
  const g = G.defineGuard(makeGuard({ read: () => ({ skip: 'still a real reason' }) }));
  const r = G.checkGate(g);
  assert.strictEqual(r.verdict, G.SKIP);
  assert.match(r.message, /still a real reason/);
});

// Minor, same validation block: read() returning null/undefined must name the problem
// rather than crash inside scan() with an unrelated TypeError.
test('read() returning null is refused with a named error', () => {
  const g = G.defineGuard(makeGuard({ read: () => null }));
  assert.throws(() => G.checkGate(g), /read\(\)/);
});

test('read() returning undefined is refused with a named error', () => {
  const g = G.defineGuard(makeGuard({ read: () => undefined }));
  assert.throws(() => G.checkGate(g), /read\(\)/);
});

// Finding 3: guardTests is one of the four named exports and the mechanism every
// downstream task uses to wire a guard into the real suite, and it had zero coverage.
// A tiny mock harness captures whether each subtest's callback throws (a real `test()`
// registers a runnable, so we invoke the callback ourselves and observe its outcome
// instead of routing through node:test's own scheduler).
function mockHarness() {
  const results = [];
  const test = (name, fn) => {
    const skips = [];
    const t = { skip: (msg) => skips.push(msg) };
    let error = null;
    try { fn(t); } catch (e) { error = e; }
    results.push({ name, error, skips });
  };
  return { test, assert, results };
}

test('guardTests: a guard that CAN fail and gates clean passes both subtests', () => {
  const g = G.defineGuard(makeGuard({ name: `gt-ok-${Math.random().toString(36).slice(2)}` }));
  const h = mockHarness();
  G.guardTests(g, h);
  assert.strictEqual(h.results.length, 2);
  assert.strictEqual(h.results[0].error, null, 'control subtest should pass');
  assert.strictEqual(h.results[1].error, null, 'gate subtest should pass');
});

test('guardTests: a CANNOT_FAIL control fails its subtest', () => {
  const g = G.defineGuard(makeGuard({
    name: `gt-cf-${Math.random().toString(36).slice(2)}`,
    control: () => ({ text: 'also clean' }),
  }));
  const h = mockHarness();
  G.guardTests(g, h);
  assert.ok(h.results[0].error, 'control subtest should fail');
  assert.match(h.results[0].error.message, /CANNOT FAIL/i);
});

test('guardTests: a VIOLATION gate fails its subtest', () => {
  const g = G.defineGuard(makeGuard({
    name: `gt-vi-${Math.random().toString(36).slice(2)}`,
    read: () => ({ text: 'this is BAD' }),
  }));
  const h = mockHarness();
  G.guardTests(g, h);
  assert.ok(h.results[1].error, 'gate subtest should fail');
  assert.match(h.results[1].error.message, /VIOLATION/i);
});

test('guardTests: a SKIP gate routes through t.skip without failing the subtest', () => {
  const g = G.defineGuard(makeGuard({
    name: `gt-sk-${Math.random().toString(36).slice(2)}`,
    read: () => ({ skip: 'no provider staged on this host' }),
  }));
  const h = mockHarness();
  G.guardTests(g, h);
  assert.strictEqual(h.results[1].error, null, 'a SKIP gate must not fail the subtest');
  assert.strictEqual(h.results[1].skips.length, 1);
  assert.match(h.results[1].skips[0], /no provider staged/);
});

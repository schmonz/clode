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

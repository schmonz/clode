'use strict';
// Characterization: node:util's isDeepStrictEqual must match host node exactly,
// including the signed-zero distinction (Node treats +0 and -0 as NOT deeply
// equal, unlike ===). A naive `if (a === b) return true;` fast-path masks this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const util = require('node:util');
const out = [];
out.push(util.isDeepStrictEqual(0, -0));
out.push(util.isDeepStrictEqual(-0, -0));
out.push(util.isDeepStrictEqual(0, 0));
out.push(util.isDeepStrictEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }));
out.push(util.isDeepStrictEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }));
out.push(util.isDeepStrictEqual(NaN, NaN));
console.log(JSON.stringify(out));
`;

test('util.isDeepStrictEqual characterization vs host node (incl. signed zero)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-util-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // Host node's actual answer, pinned so a regression in the shim OR a
  // surprise change in host node's semantics both fail loud rather than
  // silently comparing two wrong values against each other.
  assert.strictEqual(nodeOut, JSON.stringify([false, true, true, true, false, true]));
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// INTERNAL SLOTS. The implementation above walked Reflect.ownKeys only, so Map, Set,
// Date, RegExp, boxed primitives and typed arrays — all of which keep their contents in
// internal slots — looked like {} and compared EQUAL. Measured on the engine 2026-08-25,
// before the fix:
//
//     assert.deepStrictEqual(new Map([['a',1]]), new Map([['a',2]]))   PASSED
//
// assert.deepStrictEqual delegates straight to isDeepStrictEqual, so this was an
// ASSERTION THAT APPROVED UNEQUAL VALUES — every test comparing those types went green
// while measuring nothing. The characterization above could not see it because it pins
// plain objects, NaN and signed zero, all of which were already correct.
//
// Same differential shape as above: one program, run under host node AND the engine, with
// node's answer pinned so a shim regression and a host-node surprise both fail loudly.
const SLOTS_PROG = `
const util = require('node:util');
const eq = util.isDeepStrictEqual;
console.log(JSON.stringify([
  eq(new Map([['a',1]]), new Map([['a',2]])),      // false — the bug: was true
  eq(new Map([['a',1]]), new Map([['a',1]])),      // true
  eq(new Set([1]), new Set([2])),                  // false — was true
  eq(new Set([1,2]), new Set([2,1])),              // true (order-insensitive)
  eq(new Date(5), new Date(6)),                    // false — was true
  eq(new Date(5), new Date(5)),                    // true
  eq(/a/g, /b/g),                                  // false — was true
  eq(/a/g, /a/i),                                  // false (flags differ)
  eq(/a/gi, /a/gi),                                // true
  eq(new Map([[{x:1},'v']]), new Map([[{x:1},'v']])),  // true (object keys match deeply)
  eq(new Set([{x:1}]), new Set([{x:1}])),          // true (object members match deeply)
  eq(new Uint8Array([1,2]), new Uint8Array([1,3])),// false
  eq(new Uint8Array([1,2]), new Uint8Array([1,2])),// true
  eq(new Uint8Array([1]), new Int8Array([1])),     // false (different views)
  eq(Object.create(null), {}),                     // false (prototype differs)
  eq(new Number(1), new Number(2)),                // false (boxed)
]));
`;

test('util.isDeepStrictEqual sees INTERNAL SLOTS (Map/Set/Date/RegExp/typed arrays)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-util-slots-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, SLOTS_PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  assert.strictEqual(nodeOut, JSON.stringify([
    false, true, false, true, false, true, false, false, true,
    true, true, false, true, false, false, false,
  ]), 'host node changed its deep-equality semantics — read before adjusting');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

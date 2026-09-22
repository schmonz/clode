'use strict';
// Characterization: node:crypto + the shim's ACTIVE Buffer (feross/buffer when
// npm-installed deps are present; the deps-free buffer-lite fallback otherwise)
// must match host node's answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const crypto = require('node:crypto');
const out = [];
out.push(crypto.createHash('sha256').update('').digest('hex'));
out.push(crypto.createHash('sha256').update('clode').digest('hex'));
out.push(crypto.createHash('sha256').update('cl').update('ode').digest('hex'));
out.push(/^[0-9a-f-]{36}$/.test(crypto.randomUUID()));
out.push(crypto.randomBytes(16).length);
out.push(Buffer.from('hi').toString('hex'));
out.push(Buffer.from('68690a', 'hex').toString('utf8'));
out.push(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString());
out.push(Buffer.from('hello').slice(1, 3).toString());
out.push(Buffer.from('aGk=', 'base64').toString());
out.push(Buffer.byteLength('héllo'));
out.push(Buffer.isBuffer(Buffer.alloc(2)), Buffer.alloc(2)[0]);
out.push(Buffer.from('hi').toString('base64'));
out.push(Buffer.from('hello').toString('base64'));
out.push(Buffer.isBuffer(crypto.createHash('sha256').update('clode').digest()));
out.push(crypto.createHash('sha256').update('clode').digest().toString('hex'));
out.push(Buffer.from('ab').equals(Buffer.from('ab')));
out.push(Buffer.from('ab').equals(Buffer.from('ac')));
console.log(JSON.stringify(out));
`;

test('crypto + active Buffer (feross when present) characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-crypto-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// randomInt, DIFFERENTIALLY. It cannot be compared value-for-value (it is random), so
// the program below asserts the parts that ARE deterministic: the bounds hold over many
// draws, both call shapes work, the callback is asynchronous, and every argument error
// is the same CLASS with the same ordering as node's. That is what makes a missing or
// subtly-wrong export fail here instead of in a TUI that silently never paints.
//
// WHY THIS ROW EXISTS AT ALL: upstream 2.1.278 calls crypto.randomInt from a CLASS FIELD
// initializer inside the Ink render root's constructor. The shim had no randomInt, so the
// constructor threw a nameless quickjs TypeError, the rejection was swallowed by the
// bundle's own handler, and quaude's interactive TUI produced ZERO BYTES on the pty while
// `-p` stayed perfectly green. Every headless gate we own passed through that.
const RANDOM_INT_PROG = `
const crypto = require('node:crypto');
const out = [];
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < 2000; i++) { const v = crypto.randomInt(7, 11); lo = Math.min(lo, v); hi = Math.max(hi, v); }
out.push(lo >= 7, hi <= 10, Number.isInteger(lo), lo !== hi);      // in range, exclusive max, spread
out.push(crypto.randomInt(1), crypto.randomInt(5, 6));             // degenerate ranges are exact
let seen = 0;
for (let i = 0; i < 500; i++) seen |= (1 << crypto.randomInt(0, 4));
out.push(seen);                                                     // all four values occur
const err = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.constructor.name; } };
out.push(err(() => crypto.randomInt(5, 5)));                        // max must exceed min
out.push(err(() => crypto.randomInt(9, 3)));
out.push(err(() => crypto.randomInt(0, 2 ** 48 + 1)));              // node's range cap
out.push(err(() => crypto.randomInt('4')));
out.push(err(() => crypto.randomInt(0.5, 4)));
let order = '';
crypto.randomInt(0, 10, (e, v) => { order += !e && Number.isInteger(v) && v >= 0 && v < 10 ? 'cb' : 'bad'; });
order += 'sync';
setTimeout(() => { out.push(order); console.log(JSON.stringify(out)); }, 20);
`;

test('crypto.randomInt matches node on bounds, both call shapes, and error classes', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-randomint-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, RANDOM_INT_PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // The fixed answers are asserted directly too, so a host node that ever changed its
  // mind could not quietly re-bless a shim that had gone wrong with it.
  assert.strictEqual(nodeOut, '[true,true,true,true,0,5,15,"RangeError","RangeError",'
    + '"RangeError","TypeError","TypeError","synccb"]');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

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

// hash.copy(), as 2.1.330's requestDigest uses it: hash a shared prefix once, copy() it per continuation, and
// each copy goes its own way without disturbing the original. Missing, every request logged "TypeError: not a
// function at t8t" (requestDigest) on the Windows agentic legs and recorded no digest. Also: data mutated after
// update() does not change the hash (node hashes what it was given), and copy() after digest() throws
// ERR_CRYPTO_HASH_FINALIZED.
const COPY_PROG = `
const crypto = require('node:crypto');
const out = [];
const h = crypto.createHash('sha256').update('{"messages":[');
const a = h.copy().update('1]}');
const b = h.copy();
b.update('2'); b.update(']}');
out.push(a.digest('hex'), b.digest('hex'));
const c = h.copy();
out.push(h.update('3]}').digest('hex'), c.update('3]}').digest('hex'));
const buf = Buffer.from('abc');
const m = crypto.createHash('sha256').update(buf);
buf[0] = 0x7a;
out.push(m.digest('hex'));
try { h.copy(); out.push('no throw'); } catch (e) { out.push(e.code); }
console.log(JSON.stringify(out));
`;

// After digest(), as node: a Hash throws ERR_CRYPTO_HASH_FINALIZED on update(), copy() and a second digest(); an Hmac
// throws on update() but answers an EMPTY second digest(). And an Hmac, like a Hash, hashes what update() was given,
// not what the caller's buffer holds by digest() time.
const FINAL_PROG = `
const crypto = require('node:crypto');
const t = (f) => { try { const v = f(); return Buffer.isBuffer(v) ? 'buf:' + v.toString('hex') : 'ok:' + v; } catch (e) { return e.constructor.name + ' ' + e.code + ' ' + e.message; } };
const out = [];
const h = crypto.createHash('sha256').update('x'); h.digest('hex');
out.push(t(() => h.update('y')), t(() => h.digest('hex')), t(() => h.copy()));
const m = crypto.createHmac('sha256', 'key').update('x'); m.digest('hex');
out.push(t(() => m.update('y')), t(() => m.digest('hex')), t(() => m.digest()));
const buf = Buffer.from('abc');
const mm = crypto.createHmac('sha256', 'key').update(buf);
buf[0] = 0x7a;
out.push(mm.digest('hex'));
console.log(JSON.stringify(out));
`;

test('crypto Hash and Hmac after digest(), and the copy Hmac keeps of its input, exactly as node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-crypto-final-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, FINAL_PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  assert.match(nodeOut, /Error ERR_CRYPTO_HASH_FINALIZED Digest already called/, 'the host node oracle answered as expected');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

test('crypto Hash.copy() forks the running state exactly as node does', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-crypto-copy-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, COPY_PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  assert.match(nodeOut, /ERR_CRYPTO_HASH_FINALIZED/, 'the host node oracle answered as expected');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Every algorithm, natively. createHash/createHmac go through txiki's tjs:hashing (internal/hash.cjs), never a hash
// written in JS: md5, sha1, sha512 and sha3-256 (HMAC block sizes 64, 64, 128 and 136) over strings, a Buffer, a
// subarray, several updates, an empty input, a key longer than the block and a copy(); every getHashes() name, alias
// included, must be one host node lists and hash exactly as node does; and an unknown algorithm is refused with
// node's own error for each of createHash and createHmac.
const ALGS_PROG = `
const crypto = require('node:crypto');
const out = [];
const big = Buffer.alloc(70000); for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
for (const alg of ['md5', 'sha1', 'sha512', 'sha3-256', 'SHA3-256']) {
  out.push(alg,
    crypto.createHash(alg).digest('hex'),
    crypto.createHash(alg).update('cl').update(Buffer.from('ode')).digest('base64'),
    crypto.createHash(alg).update(big.subarray(5, 69000)).digest('hex'),
    crypto.createHmac(alg, 'key').update('clode').digest('hex'),
    crypto.createHmac(alg, 'k'.repeat(300)).update(big).digest('hex'),
    crypto.createHmac(alg, '').digest('hex'));
  const h = crypto.createHash(alg).update('prefix');
  out.push(h.copy().update('a').digest('hex'), h.update('b').digest('hex'));
}
const names = process.env.SHIM_HASHES ? JSON.parse(process.env.SHIM_HASHES) : crypto.getHashes();
for (const name of names) out.push(name, crypto.createHash(name).update('clode').digest('hex'), crypto.createHmac(name, 'k').update('x').digest('hex'));
const err = (f) => { try { f(); return 'no-throw'; } catch (e) { return [e.constructor.name, String(e.code), e.message].join(' '); } };
out.push(err(() => crypto.createHash('nope')), err(() => crypto.createHmac('nope', 'k')));
console.log(JSON.stringify(out));
`;

test('crypto createHash/createHmac for md5, sha1, sha512, sha3-256 and every getHashes() name match host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-crypto-algs-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, ALGS_PROG);
  // The getHashes() rows run under node with the SHIM's list, so each name is one node accepts and digests alike.
  const names = path.join(dir, 'names.cjs');
  fs.writeFileSync(names, "console.log(JSON.stringify(require('node:crypto').getHashes()));\n");
  const n = runLoader(names);
  assert.strictEqual(n.status, 0, n.stderr);
  const shimHashes = n.stdout.trim();
  assert.ok(JSON.parse(shimHashes).includes('sha3-512'), shimHashes);
  const env = { SHIM_HASHES: shimHashes };
  const r = runLoader(f, [], { env });
  assert.strictEqual(r.status, 0, r.stderr);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  assert.match(nodeOut, /Error undefined Digest method not supported/, 'the host node oracle answered as expected');
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

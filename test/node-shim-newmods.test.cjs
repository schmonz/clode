'use strict';
// Characterization for the batch-added builtins/methods (phase-3 API coverage):
// assert, querystring, string_decoder, and util.{formatWithOptions,callbackify,
// stripVTControlCharacters}. Each program runs under HOST NODE and under
// tjs+loader; outputs must match, and the host output is pinned so a shim
// regression OR a host-semantics surprise both fail loud.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function bothMatch(t, prog, pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-nm-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, prog);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  if (pin !== undefined) assert.strictEqual(nodeOut, pin, `host node output drifted:\n${nodeOut}`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut, `tjs != node:\ntjs=${r.stdout}\nnode=${nodeOut}`);
}

test('assert: ok/strictEqual/deepStrictEqual/throws/match + AssertionError.code', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const assert = require('node:assert');
const o = [];
o.push((()=>{try{assert.ok(1);assert(2);assert.strictEqual('a','a');assert.deepStrictEqual({x:[1,{y:2}]},{x:[1,{y:2}]});return 'pass'}catch(e){return 'FAIL:'+e.message}})());
o.push((()=>{try{assert.strictEqual(1,2);return 'nothrow'}catch(e){return e.code+'/'+e.name}})());
o.push((()=>{try{assert.throws(()=>{throw new TypeError('boom')},TypeError);assert.throws(()=>{throw new Error('x')},/x/);return 'pass'}catch(e){return 'FAIL:'+e.message}})());
o.push((()=>{try{assert.throws(()=>{return 1})}catch(e){return 'missing:'+e.code}})());
o.push((()=>{try{assert.match('hello',/ell/);assert.doesNotMatch('hi',/z/);return 'pass'}catch(e){return 'FAIL'}})());
o.push((()=>{try{assert.ifError(null);assert.ifError(undefined);return 'pass'}catch(e){return 'FAIL'}})());
o.push((()=>{try{assert.deepStrictEqual({a:1},{a:2});return 'nothrow'}catch(e){return e.operator}})());
console.log(JSON.stringify(o));
`;
  bothMatch(t, prog, JSON.stringify(['pass', 'ERR_ASSERTION/AssertionError', 'pass', 'missing:ERR_ASSERTION', 'pass', 'pass', 'deepStrictEqual']));
});

test('assert.rejects / doesNotReject (async)', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const assert = require('node:assert');
(async () => {
  const o = [];
  try { await assert.rejects(async()=>{throw new Error('nope')}, /nope/); o.push('rej-pass'); } catch(e){ o.push('rej-FAIL:'+e.message); }
  try { await assert.doesNotReject(async()=>42); o.push('dnr-pass'); } catch(e){ o.push('dnr-FAIL'); }
  try { await assert.rejects(async()=>1); o.push('should-throw'); } catch(e){ o.push('missing-rejection'); }
  console.log(JSON.stringify(o));
})();
`;
  bothMatch(t, prog, JSON.stringify(['rej-pass', 'dnr-pass', 'missing-rejection']));
});

test('querystring: parse/stringify/escape/unescape roundtrip + repeated keys', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const qs = require('node:querystring');
const o = [];
o.push(JSON.stringify(qs.parse('a=1&b=2&a=3&c')));
o.push(qs.stringify({a:1,b:['x','y'],c:'a b',d:true}));
o.push(JSON.stringify(qs.parse(qs.stringify({k:'a&b=c',n:42}))));
o.push(qs.escape('a b&c=d'));
o.push(qs.unescape('a%20b%26c'));
o.push(JSON.stringify(qs.parse('')));
console.log(JSON.stringify(o));
`;
  bothMatch(t, prog);
});

test('string_decoder: utf8 multibyte boundary, hex, base64, latin1', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const { StringDecoder } = require('node:string_decoder');
const o = [];
const euro = Buffer.from('€', 'utf8'); // 3 bytes
const sd = new StringDecoder('utf8');
o.push(sd.write(euro.subarray(0,2)) + '|' + sd.write(euro.subarray(2)));
const sd2 = new StringDecoder('utf8');
o.push(sd2.write(Buffer.from('héllo €', 'utf8')));
const sd3 = new StringDecoder('utf8');
o.push('[' + sd3.write(Buffer.from([0xf0,0x9f])) + ']' + '[' + sd3.end(Buffer.from([0x98,0x80])) + ']'); // emoji split
o.push(new StringDecoder('hex').write(Buffer.from([0xde,0xad,0xbe,0xef])));
o.push(new StringDecoder('base64').end(Buffer.from('hi there')));
o.push(new StringDecoder('latin1').write(Buffer.from([0xe9,0x41])));
console.log(JSON.stringify(o));
`;
  bothMatch(t, prog);
});

test('util.formatWithOptions/callbackify/stripVTControlCharacters', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const util = require('node:util');
(async () => {
  const o = [];
  o.push(util.formatWithOptions({colors:true}, '%s has %d items', 'cart', 3));
  o.push(util.stripVTControlCharacters('\\u001b[31mred\\u001b[0m\\u001b[1mbold\\u001b[0m plain'));
  const cbified = util.callbackify(async (x) => x * 2);
  const v = await new Promise((res, rej) => cbified(21, (e, r) => e ? rej(e) : res(r)));
  o.push('cb-value:' + v);
  const cbErr = util.callbackify(async () => { throw new Error('bad'); });
  const em = await new Promise((res) => cbErr((e) => res(e.message)));
  o.push('cb-err:' + em);
  const cbFalsy = util.callbackify(async () => { return Promise.reject(null); });
  const fe = await new Promise((res) => cbFalsy((e) => res(e && e.code)));
  o.push('cb-falsy:' + fe);
  console.log(JSON.stringify(o));
})();
`;
  bothMatch(t, prog, JSON.stringify(['cart has 3 items', 'redbold plain', 'cb-value:42', 'cb-err:bad', 'cb-falsy:ERR_FALSY_VALUE_REJECTION']));
});

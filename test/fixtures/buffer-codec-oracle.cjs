'use strict';
// Every base64/base64url/hex answer node's Buffer gives, asked of whatever Buffer this runs under (host node's,
// or the node-shim's: feross `buffer`) and of node-shim's deps-free fallback (internal/buffer-lite.cjs), plus the
// shim's other consumers of the codec (string_decoder, crypto digests). Prints one JSON object; the test runs it
// under host node and under the shim and compares. Strings are built from code points (the \u tool hazard).
const path = require('node:path');
const Lite = require(path.join(__dirname, '..', '..', 'libexec', 'node-shim', 'internal', 'buffer-lite.cjs')).Buffer;
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');

const cp = (...c) => String.fromCodePoint(...c);
const B64_INPUTS = ['', 'A', 'QQ', 'QQ=', 'QQ==', 'QUI', 'QUI=', 'QUJD', 'QQ==QUJD', 'QQ=QUJD', 'Q Q = =', ' QUJD\n', 'QU\tJD',
  'QUJ*D', 'a-b_', '+/+/', '-_-_', '+_-/', 'QUJDA', 'QUJDAA', 'QUJDAAA', '=QUJD', 'QR==', 'QV', '////', '____', 'Zm9vYmFy', 'Zm9vYmE',
  'Zm9v\r\nYmFy', cp(0xe9), 'QUJD====', 'QUJD=x', 'Q=UJD', `QUJD${cp(0xa0)}`, 'QUJD\f', 'QUJD\v', `Q${cp(0x1f600)}UJD`, 'QUJD\u0000',
  'Zm9v YmFy', 'Pj4-', 'Pj4+', 'Pj4_Pz8/'];
const HEX_INPUTS = ['', 'a', 'ab', 'abc', 'abcd', 'zz12', '12zz34', '1g', 'AbCdEf', ' 12', '12 34', '0x12', 'ffF', '0001ff', 'FFfe0a'];
const BYTES = [[], [0], [0x41], [0x41, 0x42], [0x41, 0x42, 0x43], [0xfb, 0xff, 0xbf], [0x3e, 0x3e, 0x3e], [0xff, 0xfe, 0xfd, 0xfc],
  Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)];
const ENCS = ['base64', 'base64url', 'hex', 'BASE64', 'Base64Url', 'HEX'];
const RANGES = [[], [1], [2, 5], [-3, 4], [0, 99], [5, 2], [undefined, 3]];

const hexOf = (u8) => Array.from(u8, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
const tryIt = (f) => { try { return f(); } catch (e) { return `throws ${e.name}`; } };

function answers(B) {
  const out = [];
  for (const e of ENCS) {
    for (const b of BYTES) {
      out.push(['toString', e, b.length, tryIt(() => B.from(b).toString(e))]);
      for (const r of RANGES) out.push(['toString range', e, b.length, r, tryIt(() => B.from(b).toString(e, ...r))]);
    }
    for (const s of e.toLowerCase() === 'hex' ? HEX_INPUTS : B64_INPUTS) {
      out.push(['from', e, s, tryIt(() => hexOf(B.from(s, e)))]);
      if (typeof B.byteLength === 'function') out.push(['byteLength', e, s, tryIt(() => B.byteLength(s, e))]);
    }
  }
  return out;
}

// The members only the full Buffer has (buffer-lite is the toolchain's subset): write, fill, alloc with a fill,
// toLocaleString, inspect's hex, and the encoding probe.
function fullAnswers(B) {
  const out = [];
  for (const e of ENCS) {
    for (const s of e.toLowerCase() === 'hex' ? HEX_INPUTS : B64_INPUTS) {
      for (const args of [[], [1], [1, 2], [0, 1], [3, 0]]) {
        out.push(['write', e, s, args, tryIt(() => { const t = B.alloc(6, 0x2e); const n = t.write(s, ...args, e); return `${n}:${hexOf(t)}`; })]);
      }
      out.push(['fill', e, s, tryIt(() => hexOf(B.alloc(7).fill(s, e)))]);
      out.push(['alloc fill', e, s, tryIt(() => hexOf(B.alloc(5, s, e)))]);
    }
    out.push(['isEncoding', e, B.isEncoding(e)]);
  }
  out.push(['toLocaleString', B.from([1, 2, 250]).toLocaleString('hex'), B.from([1, 2, 250]).toLocaleString('base64')]);
  out.push(['write default length', tryIt(() => { const t = B.alloc(4); return `${t.write('QUJDREVG', 'base64')}:${hexOf(t)}`; })]);
  return out;
}

function decoderAnswers() {
  const out = [];
  const bytes = Array.from({ length: 11 }, (_, i) => (i * 59 + 7) & 0xff);
  for (const enc of ['base64', 'base64url', 'hex']) {
    for (const cut of [[], [1], [2], [1, 2], [4, 5, 9], [3, 6]]) {
      const d = new StringDecoder(enc);
      let s = '', at = 0;
      for (const c of cut) { s += `${d.write(Buffer.from(bytes.slice(at, c)))}|`; at = c; }
      s += `${d.write(Buffer.from(bytes.slice(at)))}|${d.end()}`;
      out.push(['StringDecoder', enc, cut, s]);
    }
  }
  return out;
}

function cryptoAnswers() {
  const out = [];
  for (const enc of ['hex', 'base64', 'base64url']) {
    out.push(['digest', enc, crypto.createHash('sha256').update('clode').digest(enc)]);
    out.push(['hmac', enc, crypto.createHmac('sha256', 'k').update('clode').digest(enc)]);
  }
  for (const [s, e] of [['636c6f6465', 'hex'], ['636C6F6465', 'hex'], ['636c6f64zz', 'hex'], ['636c6f646', 'hex'], ['Y2xvZGU=', 'base64'], ['Y2xvZGU', 'base64url']]) {
    out.push(['update', e, s, tryIt(() => crypto.createHash('sha256').update(s, e).digest('hex'))]);
  }
  return out;
}

console.log(JSON.stringify({
  buffer: answers(Buffer),
  full: fullAnswers(Buffer),
  lite: answers(Lite),
  decoder: decoderAnswers(),
  crypto: cryptoAnswers(),
}));

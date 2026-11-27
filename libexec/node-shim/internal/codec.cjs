'use strict';
// node-shim's ONE base64/base64url/hex codec, with node's Buffer semantics. Every shim consumer goes through
// it: modules/buffer.cjs (over feross `buffer`), internal/buffer-lite.cjs, string_decoder, crypto and x509.
//
// The work is the engine's: QuickJS-ng's native Uint8Array.prototype.toBase64/toHex and
// Uint8Array.fromBase64/fromHex (TC39 "Uint8Array to/from base64", quickjs.c). Per-byte JS here cost ~3s to
// decode a 10MB attachment's base64 under tjs; native is two orders of magnitude faster. No alphabet is
// written down in this file or anywhere else in libexec (test/build-gates/host-provision-gates.test.cjs,
// no-hand-written-base64).
//
// NODE'S DECODING IS LENIENT, THE NATIVE ONE IS STRICT, and node's answer is the one that counts:
//   base64 and base64url decode alike: both alphabets, every other character skipped, decoding stops at the
//     first '=', a trailing lone character yields nothing, and each UTF-16 code unit is read as its LOW BYTE
//     (node casts it to uint8_t, so U+0141 is 'A' and an emoji's high surrogate, 0xD83D, is '=').
//   hex decodes pairs up to the first pair that is not two hex digits (low bytes again).
// So the native decoder runs first and answers whenever the input is canonical (then the two agree; the
// differential in test/node-shim-buffer-codec.test.cjs holds that), and when it refuses (SyntaxError) the
// input is first reduced, by node's rules, to the canonical string node would have decoded.
//
// Host node 24 (the suite's own runtime, which loads buffer-lite directly) has no native Uint8Array base64;
// there btoa/atob, which every runtime has natively, stand in. Still no table.
const NATIVE = typeof Uint8Array.fromBase64 === 'function' && typeof Uint8Array.prototype.toBase64 === 'function'
  && typeof Uint8Array.fromHex === 'function' && typeof Uint8Array.prototype.toHex === 'function';
const toBase64Native = NATIVE ? Uint8Array.prototype.toBase64 : null;
const toHexNative = NATIVE ? Uint8Array.prototype.toHex : null;
const URL_OPTS = { alphabet: 'base64url', omitPadding: true };
const LOOSE = { lastChunkHandling: 'loose' };
const LOOSE_URL = { alphabet: 'base64url', lastChunkHandling: 'loose' };

// node's encoding name for one of these three codecs (any case), or null.
function codecOf(enc) {
  if (typeof enc !== 'string') return null;
  const e = enc.length <= 9 ? enc.toLowerCase() : '';
  return e === 'base64' || e === 'base64url' || e === 'hex' ? e : null;
}

const asView = (u8) => (u8 instanceof Uint8Array ? u8 : new Uint8Array(u8.buffer ?? u8, u8.byteOffset ?? 0, u8.byteLength ?? u8.length));

const CHUNK = 0x8000;
function latin1Of(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  return s;
}
function bytesOfLatin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
// node reads each UTF-16 code unit of a base64/hex string as its low byte.
const WIDE = /[Ā-￿]/;
const lowBytes = (s) => (WIDE.test(s) ? s.replace(/[Ā-￿]/g, (c) => String.fromCharCode(c.charCodeAt(0) & 0xff)) : s);

function toBase64(u8) {
  const v = asView(u8);
  return NATIVE ? toBase64Native.call(v) : btoa(latin1Of(v));
}
function toBase64Url(u8) {
  const v = asView(u8);
  return NATIVE ? toBase64Native.call(v, URL_OPTS) : toBase64(v).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function toHex(u8) {
  const v = asView(u8);
  if (NATIVE) return toHexNative.call(v);
  let s = '';
  for (let i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
  return s;
}

// The bytes node decodes from a base64 or base64url string (the two are one decoder in node).
function fromBase64(str) {
  const s = String(str);
  if (NATIVE) {
    // Each alphabet in turn rather than scanning for '-' or '_' first: under QuickJS a regex scan of a 14MB string
    // costs ~270ms and two indexOf ~60ms, while a decode refused at the first foreign character costs nothing more.
    for (const opts of [LOOSE, LOOSE_URL]) {
      try { return Uint8Array.fromBase64(s, opts); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    }
  }
  let t = lowBytes(s);
  const eq = t.indexOf('=');
  if (eq >= 0) t = t.slice(0, eq);
  t = t.replace(/[^0-9A-Za-z+/_-]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (t.length % 4 === 1) t = t.slice(0, -1);
  return NATIVE ? Uint8Array.fromBase64(t, LOOSE) : bytesOfLatin1(atob(t));
}

// The bytes node decodes from a hex string: whole pairs up to the first that is not two hex digits.
function fromHex(str) {
  const s = String(str);
  if (NATIVE) {
    try { return Uint8Array.fromHex(s); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  }
  let t = lowBytes(s);
  const bad = t.search(/[^0-9A-Fa-f]/);
  t = t.slice(0, (bad < 0 ? t.length : bad) & ~1);
  if (NATIVE) return Uint8Array.fromHex(t);
  const out = new Uint8Array(t.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(2 * i, 2), 16);
  return out;
}

// node's Buffer.byteLength(str, 'base64'|'base64url'): an estimate from the length alone (up to two trailing
// '=' dropped), never a decode; 'hex': half the length.
function byteLength(str, codec) {
  const s = String(str);
  if (codec === 'hex') return s.length >>> 1;
  let n = s.length;
  if (n > 0 && s.charCodeAt(n - 1) === 0x3d) n--;
  if (n > 1 && s.charCodeAt(n - 1) === 0x3d) n--;
  return (n * 3) >>> 2;
}

const encode = (u8, codec) => (codec === 'hex' ? toHex(u8) : codec === 'base64url' ? toBase64Url(u8) : toBase64(u8));
const decode = (str, codec) => (codec === 'hex' ? fromHex(str) : fromBase64(str));

module.exports = { NATIVE, codecOf, toBase64, toBase64Url, toHex, fromBase64, fromHex, byteLength, encode, decode };

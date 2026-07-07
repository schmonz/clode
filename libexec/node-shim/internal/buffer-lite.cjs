'use strict';
// Buffer-lite: the toolchain's Buffer surface as a Uint8Array subclass.
// M2 replaces this with the vendored feross `buffer` for the bundle's needs.
const te = new TextEncoder();
const td = new TextDecoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64decode(s) {
  s = s.replace(/=+$/, '');
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}
function b64encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b ?? 0) >> 4]
      + (b === undefined ? '=' : B64[((b & 15) << 2) | (c ?? 0) >> 6])
      + (c === undefined ? '=' : B64[c & 63]);
  }
  return out;
}

class Buffer extends Uint8Array {
  static from(src, enc) {
    if (typeof src === 'string') {
      if (enc === 'hex') return new Buffer(Uint8Array.from(src.match(/../g) ?? [], (h) => parseInt(h, 16)));
      if (enc === 'base64') return new Buffer(b64decode(src));
      // latin1/binary: low-byte of each code point (NOT utf-8). This is the
      // extractor's write path: Buffer.from(latin1Text, 'latin1') must map
      // 1 char -> 1 byte or bytes >= 0x80 corrupt.
      if (enc === 'latin1' || enc === 'binary') return new Buffer(Uint8Array.from({ length: src.length }, (_, i) => src.charCodeAt(i) & 0xff));
      return new Buffer(te.encode(src));
    }
    if (src instanceof ArrayBuffer) return new Buffer(new Uint8Array(src));
    return new Buffer(Uint8Array.from(src));
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(v) { return v instanceof Buffer; }
  static byteLength(s) { return te.encode(String(s)).length; }
  static concat(list) {
    const total = list.reduce((n, b) => n + b.length, 0);
    const out = new Buffer(total);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }
  toString(enc) {
    if (enc === 'hex') return [...this].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64') return b64encode(this);
    if (enc === 'latin1' || enc === 'binary') {
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < this.length; i += CH) s += String.fromCharCode.apply(null, this.subarray(i, Math.min(i + CH, this.length)));
      return s;
    }
    return td.decode(this);
  }
  slice(a, b) { return new Buffer(super.slice(a, b)); }
  equals(other) { return this.length === other.length && this.every((v, i) => v === other[i]); }
}
module.exports = { Buffer };

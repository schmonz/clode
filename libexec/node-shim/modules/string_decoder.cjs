'use strict';
// node:string_decoder — StringDecoder that buffers incomplete multibyte
// sequences across chunk boundaries (the whole point of the class; used by
// Readable#setEncoding and the bundle 7×). utf8/utf16le use a streaming
// TextDecoder (exactly Node's boundary semantics); latin1/ascii are 1:1 byte
// maps; base64/hex buffer to a whole group. Characterization-locked against host
// node in test/node-shim-string-decoder.test.cjs.
function normalize(enc) {
  enc = String(enc || 'utf8').toLowerCase();
  if (enc === 'utf-8') return 'utf8';
  if (enc === 'ucs2' || enc === 'ucs-2' || enc === 'utf-16le') return 'utf16le';
  if (enc === 'binary') return 'latin1';
  return enc;
}

function toU8(buf) {
  if (buf == null) return new Uint8Array(0);
  if (typeof buf === 'string') return globalThis.Buffer.from(buf); // Node: a string arg is returned as-is by write, but Buffer path is the norm
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
}

class StringDecoder {
  constructor(encoding) {
    this.encoding = normalize(encoding);
    this._carry = new Uint8Array(0); // buffered trailing bytes
    if (this.encoding === 'utf8' || this.encoding === 'utf16le') {
      this._td = new TextDecoder(this.encoding === 'utf8' ? 'utf-8' : 'utf-16le');
    }
  }

  write(buffer) {
    if (typeof buffer === 'string') return buffer;
    const bytes = toU8(buffer);
    const enc = this.encoding;
    if (enc === 'utf8' || enc === 'utf16le') {
      // TextDecoder with {stream:true} buffers a trailing incomplete unit and
      // emits it on the next write — exactly Node's contract.
      return this._td.decode(bytes, { stream: true });
    }
    if (enc === 'latin1') {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    if (enc === 'ascii') {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
      return s;
    }
    if (enc === 'hex') {
      const all = concat(this._carry, bytes);
      const evenLen = all.length; // hex is byte->2 chars; no partial byte possible
      this._carry = new Uint8Array(0);
      let s = '';
      for (let i = 0; i < evenLen; i++) s += all[i].toString(16).padStart(2, '0');
      return s;
    }
    if (enc === 'base64' || enc === 'base64url') {
      const all = concat(this._carry, bytes);
      const whole = all.length - (all.length % 3);
      this._carry = all.subarray(whole);
      return whole ? b64(all.subarray(0, whole), enc === 'base64url') : '';
    }
    // Unknown encoding: decode as utf8 best-effort would hide the gap — fail loud.
    throw new Error(`node-shim: string_decoder encoding '${enc}' not implemented`);
  }

  end(buffer) {
    let out = '';
    if (buffer !== undefined) out += this.write(buffer);
    const enc = this.encoding;
    if (enc === 'utf8' || enc === 'utf16le') {
      out += this._td.decode(); // flush: emits U+FFFD for any dangling bytes, as Node does
      return out;
    }
    if ((enc === 'base64' || enc === 'base64url') && this._carry.length) {
      out += b64(this._carry, enc === 'base64url');
      this._carry = new Uint8Array(0);
    }
    return out;
  }
}

function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function b64(u8, url) {
  const s = globalThis.Buffer.from(u8).toString(url ? 'base64url' : 'base64');
  return s;
}

module.exports = { StringDecoder };
module.exports.default = module.exports;

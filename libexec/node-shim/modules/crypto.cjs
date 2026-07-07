'use strict';
// node:crypto — M1 surface: createHash('sha256'), randomUUID, randomBytes,
// webcrypto passthrough. KAT-locked against host node.
const { sha256 } = require('./../internal/sha256.cjs');
const te = new TextEncoder();

function createHash(alg) {
  if (alg !== 'sha256') throw new Error(`node-shim: crypto.createHash('${alg}') not implemented`);
  const chunks = [];
  return {
    update(data) { chunks.push(typeof data === 'string' ? te.encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length)); return this; },
    digest(enc) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      const d = sha256(all);
      if (enc === 'hex') return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
      return globalThis.Buffer.from(d);
    },
  };
}

module.exports = {
  createHash,
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (n) => { const b = globalThis.Buffer.alloc(n); crypto.getRandomValues(b); return b; },
  webcrypto: crypto,
};

'use strict';
// Hashing under tjs: txiki's own tjs:hashing module (mbedtls, ~320MB/s), never a hash written in JS.
//
// WHY. The shim used to carry a pure-JS SHA-256. It cost 3.6s for the 5.4MB engine template and minutes for the
// ~265MB provider, so clode-net.cjs's file hash went out to a host tool instead (sha256sum, shasum, ...), which
// Mac OS X Tiger does not have: a Tiger first run could not verify its download. tjs:hashing was in the engine
// all along. test/build-gates/host-provision-gates.test.cjs refuses a hand-written hash in libexec.
//
// tjs:hashing is an ES module, so CJS code cannot import it synchronously: libexec/node-shim/loader.cjs (and
// libexec/quaude-bootstrap.mjs) await import('tjs:hashing') before the entry runs and leave it on
// globalThis.__clodeTjsHashing. Its Hash has update(string | TypedArray), digest() -> lowercase hex and
// bytes() -> Uint8Array; update() refuses a bare ArrayBuffer, and there is no copy().

// node's algorithm names (lowercased; node matches them case-insensitively) -> tjs:hashing's. Every alias here is
// one host node's crypto.getHashes() lists and that names exactly the same digest; test/node-shim-crypto.test.cjs
// holds each one to host node.
const CANONICAL = {
  md5: 'md5', sha1: 'sha1', sha224: 'sha224', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512',
  'sha512-224': 'sha512_224', 'sha512-256': 'sha512_256',
  'sha3-224': 'sha3_224', 'sha3-256': 'sha3_256', 'sha3-384': 'sha3_384', 'sha3-512': 'sha3_512',
};
const ALIASES = {
  'rsa-md5': 'md5', 'ssl3-md5': 'md5', md5withrsaencryption: 'md5',
  'rsa-sha1': 'sha1', 'sha-1': 'sha1', 'ssl3-sha1': 'sha1', sha1withrsaencryption: 'sha1',
  'rsa-sha224': 'sha224', 'sha-224': 'sha224', 'sha2-224': 'sha224', sha224withrsaencryption: 'sha224',
  'rsa-sha256': 'sha256', 'sha-256': 'sha256', 'sha2-256': 'sha256', sha256withrsaencryption: 'sha256',
  'rsa-sha384': 'sha384', 'sha-384': 'sha384', 'sha2-384': 'sha384', sha384withrsaencryption: 'sha384',
  'rsa-sha512': 'sha512', 'sha-512': 'sha512', 'sha2-512': 'sha512', sha512withrsaencryption: 'sha512',
  'rsa-sha512/224': 'sha512-224', 'sha-512/224': 'sha512-224', 'sha2-512/224': 'sha512-224', 'sha512-224withrsaencryption': 'sha512-224',
  'rsa-sha512/256': 'sha512-256', 'sha-512/256': 'sha512-256', 'sha2-512/256': 'sha512-256', 'sha512-256withrsaencryption': 'sha512-256',
  'rsa-sha3-224': 'sha3-224', 'rsa-sha3-256': 'sha3-256', 'rsa-sha3-384': 'sha3-384', 'rsa-sha3-512': 'sha3-512',
};

// HMAC's block size per algorithm (RFC 2104: the key is padded or hashed to this many bytes). SHA-3's is its rate.
const BLOCK = {
  md5: 64, sha1: 64, sha224: 64, sha256: 64,
  sha384: 128, sha512: 128, 'sha512-224': 128, 'sha512-256': 128,
  'sha3-224': 144, 'sha3-256': 136, 'sha3-384': 104, 'sha3-512': 72,
};

// The canonical node name for `alg`, or null when this shim cannot hash it.
function nodeName(alg) {
  const a = String(alg).toLowerCase();
  if (CANONICAL[a]) return a;
  return ALIASES[a] || null;
}

// Every name node accepts that this shim hashes (getHashes()).
function supportedNames() {
  return [...Object.keys(CANONICAL), ...Object.keys(ALIASES)];
}

function hashing() {
  const h = globalThis.__clodeTjsHashing;
  if (!h || typeof h.createHash !== 'function') {
    throw new Error('node-shim: no tjs:hashing in this engine (globalThis.__clodeTjsHashing is unset: the loader '
      + 'imports it before the entry runs), so node:crypto cannot hash');
  }
  return h;
}

// Digest a list of Uint8Array chunks with the node-named algorithm `name` (from nodeName()) -> Uint8Array.
function digestChunks(name, chunks) {
  const h = hashing().createHash(CANONICAL[name]);
  for (const c of chunks) if (c.length) h.update(c);
  return h.bytes();
}

module.exports = { nodeName, supportedNames, digestChunks, blockSize: (name) => BLOCK[name], hashing };

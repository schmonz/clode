'use strict';
// node:crypto — surface: createHash('sha256'), createHmac('sha256'), randomUUID,
// randomBytes, randomFillSync, randomInt, timingSafeEqual, getHashes, constants, webcrypto
// passthrough. Hash/HMAC are KAT-locked against host node. Algorithms beyond
// sha256 (md5/sha1/sha512) and the asymmetric/KDF surface (createSign/Verify,
// createPrivateKey/PublicKey, pbkdf2, X509Certificate) are NOT implemented here —
// this build has no native OpenSSL and a wrong stub would violate fail-loud, so
// they remain walls (see phase3-api-coverage.md "needs-investigation").
const { sha256 } = require('./../internal/sha256.cjs');
const te = new TextEncoder();

function toBytes(data, enc) {
  if (typeof data === 'string') {
    if (!enc || enc === 'utf8' || enc === 'utf-8') return te.encode(data);
    if (enc === 'hex') { const u = new Uint8Array(data.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(data.substr(i * 2, 2), 16); return u; }
    return new Uint8Array(globalThis.Buffer.from(data, enc));
  }
  return new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
}

function encodeDigest(d, enc) {
  if (enc === 'hex') return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (enc) return globalThis.Buffer.from(d).toString(enc);
  return globalThis.Buffer.from(d);
}

function createHash(alg) {
  const a = String(alg).toLowerCase();
  if (a !== 'sha256') throw new Error(`node-shim: crypto.createHash('${alg}') not implemented (only sha256)`);
  const chunks = [];
  return {
    update(data, enc) { chunks.push(toBytes(data, enc)); return this; },
    digest(enc) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total);
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      return encodeDigest(sha256(all), enc);
    },
  };
}

// HMAC-SHA256 (RFC 2104) over the internal sha256; block size 64 bytes.
function createHmac(alg, key) {
  const a = String(alg).toLowerCase();
  if (a !== 'sha256') throw new Error(`node-shim: crypto.createHmac('${alg}') not implemented (only sha256)`);
  const BLOCK = 64;
  let k = toBytes(key);
  if (k.length > BLOCK) k = sha256(k);
  const kpad = new Uint8Array(BLOCK); kpad.set(k);
  const ipad = new Uint8Array(BLOCK), opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) { ipad[i] = kpad[i] ^ 0x36; opad[i] = kpad[i] ^ 0x5c; }
  const chunks = [];
  return {
    update(data, enc) { chunks.push(toBytes(data, enc)); return this; },
    digest(enc) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const inner = new Uint8Array(BLOCK + total);
      inner.set(ipad); let o = BLOCK; for (const c of chunks) { inner.set(c, o); o += c.length; }
      const innerHash = sha256(inner);
      const outer = new Uint8Array(BLOCK + innerHash.length);
      outer.set(opad); outer.set(innerHash, BLOCK);
      return encodeDigest(sha256(outer), enc);
    },
  };
}

// Constant-time equality of two equal-length byte views (throws on length
// mismatch, like Node). The compare itself is branch-free over the byte diff.
function timingSafeEqual(a, b) {
  const ua = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength ?? a.length);
  const ub = new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength ?? b.length);
  if (ua.length !== ub.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// WEBCRYPTO CAPS getRandomValues AT 65536 BYTES PER CALL; node's randomBytes has no cap.
// Asking for more threw QuotaExceededError — found 2026-08-25 by a test requesting 200000
// bytes. Fill in chunks so the shim matches node's contract instead of the web platform's.
const RNG_CHUNK = 65536;
function fillRandom(view) {
  for (let off = 0; off < view.length; off += RNG_CHUNK) {
    crypto.getRandomValues(view.subarray(off, Math.min(off + RNG_CHUNK, view.length)));
  }
  return view;
}

function randomFillSync(buf, offset = 0, size) {
  const view = new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
  const end = size === undefined ? view.length : offset + size;
  fillRandom(view.subarray(offset, end));
  return buf;
}

// node:crypto's randomInt — NEW REQUIREMENT AT UPSTREAM 2.1.278, and its absence was
// not a graceful degradation. The bundle's Ink renderer grew a graphics-id allocator
// whose CLASS FIELD initializer is `nextWide = randomInt(min, max)`, so the field runs
// while the render root is being CONSTRUCTED. A missing export therefore threw a bare
// "not a function" (quickjs TypeErrors carry no name) out of the root constructor, the
// rejection was swallowed by the bundle's own handler, and the interactive TUI simply
// never painted: zero bytes on the pty, 0% CPU, event loop still alive. `-p` was
// unaffected, so every headless gate stayed green. Measured 2026-09-22 by bisecting the
// startup with trace markers; see test/fidelity/RESULTS.md.
//
// SEMANTICS ARE NODE'S, not "a random number in range": min inclusive, max EXCLUSIVE,
// both safe integers, max > min, and the range capped at 2**48 exactly as node caps it.
// The sampler is rejection sampling over whole bytes with the value masked down to the
// range's bit width first, so at most half of the draws are ever rejected and the result
// is uniform — a plain `% range` would be biased, which for an id allocator means
// collisions clustering at the low end.
const RANDOM_INT_MAX_RANGE = 281474976710656; // 2**48, node's own cap
function randomInt(min, max, cb) {
  if (typeof max === 'function') { cb = max; max = undefined; }
  if (max === undefined) { max = min; min = 0; }
  if (typeof min !== 'number' || typeof max !== 'number') {
    throw new TypeError('The "min" and "max" arguments must be of type number');
  }
  // TypeError, not RangeError, and that asymmetry is node's, not a guess: node validates
  // the bounds with ERR_INVALID_ARG_TYPE ('a safe integer'), and keeps RangeError for the
  // two RELATIONAL failures below (max <= min, and the 2**48 cap). Differentially locked
  // in test/node-shim-crypto.test.cjs, which reads both classes off host node.
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new TypeError('The "min"/"max" argument must be a safe integer');
  }
  if (max <= min) {
    throw new RangeError('The value of "max" is out of range. It must be greater than '
      + `the value of "min" (${min}). Received ${max}`);
  }
  const range = max - min;
  if (range > RANDOM_INT_MAX_RANGE) {
    throw new RangeError('The value of "max - min" is out of range. '
      + `It must be <= 2**48. Received ${range}`);
  }
  let bits = 0;
  for (let r = range - 1; r > 0; r = Math.floor(r / 2)) bits++;
  const bytes = Math.max(1, Math.ceil(bits / 8));
  const cap = Math.pow(2, bits);
  const buf = new Uint8Array(bytes);
  const pick = () => {
    for (;;) {
      fillRandom(buf);
      let v = 0;
      for (let i = 0; i < bytes; i++) v = (v * 256) + buf[i];
      v %= cap;                         // == masking to `bits`; keeps rejection under 50%
      if (v < range) return min + v;
    }
  };
  if (cb === undefined) return pick();
  if (typeof cb !== 'function') throw new TypeError('The "callback" argument must be of type function');
  // node's callback form is ASYNCHRONOUS; calling back inline would let a caller observe
  // an ordering node never produces.
  setTimeout(() => { let v; try { v = pick(); } catch (e) { cb(e); return; } cb(undefined, v); }, 0);
  return undefined;
}

// We implement only sha256 hashing/HMAC; report exactly that so feature-detection
// (getHashes().includes(x)) never selects an algorithm we would then throw on.
function getHashes() { return ['sha256']; }

const constants = {"OPENSSL_VERSION_NUMBER":811597872,"SSL_OP_ALL":2147485776,"SSL_OP_ALLOW_NO_DHE_KEX":1024,"SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION":262144,"SSL_OP_CIPHER_SERVER_PREFERENCE":4194304,"SSL_OP_CISCO_ANYCONNECT":32768,"SSL_OP_COOKIE_EXCHANGE":8192,"SSL_OP_CRYPTOPRO_TLSEXT_BUG":2147483648,"SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS":2048,"SSL_OP_LEGACY_SERVER_CONNECT":4,"SSL_OP_NO_COMPRESSION":131072,"SSL_OP_NO_ENCRYPT_THEN_MAC":524288,"SSL_OP_NO_QUERY_MTU":4096,"SSL_OP_NO_RENEGOTIATION":1073741824,"SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION":65536,"SSL_OP_NO_SSLv2":0,"SSL_OP_NO_SSLv3":33554432,"SSL_OP_NO_TICKET":16384,"SSL_OP_NO_TLSv1":67108864,"SSL_OP_NO_TLSv1_1":268435456,"SSL_OP_NO_TLSv1_2":134217728,"SSL_OP_NO_TLSv1_3":536870912,"SSL_OP_PRIORITIZE_CHACHA":2097152,"SSL_OP_TLS_ROLLBACK_BUG":8388608,"ENGINE_METHOD_RSA":1,"ENGINE_METHOD_DSA":2,"ENGINE_METHOD_DH":4,"ENGINE_METHOD_RAND":8,"ENGINE_METHOD_EC":2048,"ENGINE_METHOD_CIPHERS":64,"ENGINE_METHOD_DIGESTS":128,"ENGINE_METHOD_PKEY_METHS":512,"ENGINE_METHOD_PKEY_ASN1_METHS":1024,"ENGINE_METHOD_ALL":65535,"ENGINE_METHOD_NONE":0,"DH_CHECK_P_NOT_SAFE_PRIME":2,"DH_CHECK_P_NOT_PRIME":1,"DH_UNABLE_TO_CHECK_GENERATOR":4,"DH_NOT_SUITABLE_GENERATOR":8,"RSA_PKCS1_PADDING":1,"RSA_SSLV23_PADDING":2,"RSA_NO_PADDING":3,"RSA_PKCS1_OAEP_PADDING":4,"RSA_X931_PADDING":5,"RSA_PKCS1_PSS_PADDING":6,"RSA_PSS_SALTLEN_DIGEST":-1,"RSA_PSS_SALTLEN_MAX_SIGN":-2,"RSA_PSS_SALTLEN_AUTO":-2,"TLS1_VERSION":769,"TLS1_1_VERSION":770,"TLS1_2_VERSION":771,"TLS1_3_VERSION":772,"POINT_CONVERSION_COMPRESSED":2,"POINT_CONVERSION_UNCOMPRESSED":4,"POINT_CONVERSION_HYBRID":6};

module.exports = {
  createHash,
  createHmac,
  timingSafeEqual,
  getHashes,
  constants,
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (n) => { const b = globalThis.Buffer.alloc(n); fillRandom(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); return b; },
  randomFillSync,
  randomInt,
  // getRandomValues keeps the WEB contract (it IS the web API): callers of the web
  // name get the web cap. Only node's own randomBytes/randomFillSync are uncapped.
  getRandomValues: (a) => crypto.getRandomValues(a),
  webcrypto: crypto,
};

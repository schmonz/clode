'use strict';
// crypto.X509Certificate — the members a certificate's own bytes answer, read from its DER.
//
// WHY. 2.1.330's CA-trust builder hashes every bundled root (`new X509Certificate(pem).raw`, then sha256) to match
// them against its deny list, and reads validTo to drop expired system roots. The shim had no X509Certificate at
// all, so `new undefined(pem)` threw, and every quaude start logged, once per bundled root,
// `[ERROR] CA certs: A bundled root does not parse: TypeError: not a function` (16 times in a live NetBSD/arm64
// --debug-file log, 2026-11-23). Native parses them and logs nothing.
//
// WHAT IS REAL (each against host node on the same PEMs, test/node-shim-x509.test.cjs): the constructor (PEM or
// DER, string or bytes; node's errors for no PEM block, malformed DER and a non-bytes argument), raw, toString,
// toJSON, serialNumber, fingerprint256, validFrom, validTo, validFromDate, validToDate, ca.
//
// WHAT IS A WALL, by name (a getter or method that throws a branded error; never a guess): subject, issuer,
// subjectAltName, infoAccess, keyUsage, issuerCertificate, fingerprint, fingerprint512, signatureAlgorithm,
// signatureAlgorithmOid, publicKey, checkHost, checkEmail, checkIP, checkIssued, checkPrivateKey, verify,
// toLegacyObject. subject/issuer need OpenSSL's distinguished-name printer, publicKey a KeyObject, verify and
// checkIssued signature checks; fingerprint/fingerprint512 need SHA-1/SHA-512, which the shim does not have. Every
// 2.1.330 site that reads one of them is inside a try/catch, and each catch keeps the certificate or skips the
// check (read at the pin, 2026-11-23; test/shim-surface/golden.json's crypto.X509Certificate note), so a wall
// there lands where a certificate that does not parse used to.
//
// DIVERGENCE, by name: a malformed certificate inside a PEM block is refused with OpenSSL's ASN.1 error for the
// first fault this reader meets ("header too long", "too long", "wrong tag"); OpenSSL's decoder walks the template
// in its own order, so a certificate with SEVERAL faults may be named by a different one of them.
const { digestChunks } = require('./hash.cjs');
const { invalidArgType } = require('./node-errors.cjs');

const CERT_LABELS = ['CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE'];

function osslError(library, reason, hex, code) {
  return Object.assign(new Error(`error:${hex}:${library}::${reason}`), { library, reason, code });
}
const noStartLine = () => osslError('PEM routines', 'no start line', '0480006C', 'ERR_OSSL_PEM_NO_START_LINE');

// OpenSSL's three ASN.1 reasons for a DER that does not read, by what went wrong
const ASN1 = {
  'header too long': ['0680007B', 'ERR_OSSL_ASN1_HEADER_TOO_LONG'],
  'too long': ['0680009B', 'ERR_OSSL_ASN1_TOO_LONG'],
  'wrong tag': ['068000A8', 'ERR_OSSL_ASN1_WRONG_TAG'],
};
class Malformed extends Error { constructor(reason = 'wrong tag') { super(reason); this.reason = reason; } }
const asn1Error = (reason) => osslError('asn1 encoding routines', reason, ...ASN1[reason]);

// One DER TLV at `pos` of `b`, which must end by `end`: { tag, start (of contents), end (of contents) }.
function tlv(b, pos, end) {
  if (pos + 2 > end) throw new Malformed('header too long');
  const tag = b[pos];
  let len = b[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > end) throw new Malformed('header too long');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  if (p + len > end) throw new Malformed('too long');
  return { tag, start: p, end: p + len };
}
function expect(b, pos, end, tag) {
  const t = tlv(b, pos, end);
  if (t.tag !== tag) throw new Malformed();
  return t;
}

// The DER of one Certificate (RFC 5280 4.1), checked for its shape and read for the fields served here.
function parseCertificate(b) {
  const cert = expect(b, 0, b.length, 0x30);
  const tbs = expect(b, cert.start, cert.end, 0x30);
  let p = tbs.start;
  let t = tlv(b, p, tbs.end);
  if (t.tag === 0xa0) { p = t.end; t = tlv(b, p, tbs.end); }        // [0] version
  if (t.tag !== 0x02) throw new Malformed();
  const serial = b.subarray(t.start, t.end);
  p = t.end;
  p = expect(b, p, tbs.end, 0x30).end;                               // signature AlgorithmIdentifier
  p = expect(b, p, tbs.end, 0x30).end;                               // issuer
  const validity = expect(b, p, tbs.end, 0x30);
  const nb = tlv(b, validity.start, validity.end);
  const na = tlv(b, nb.end, validity.end);
  const notBefore = asn1Time(b, nb), notAfter = asn1Time(b, na);
  p = validity.end;
  p = expect(b, p, tbs.end, 0x30).end;                               // subject
  p = expect(b, p, tbs.end, 0x30).end;                               // subjectPublicKeyInfo
  let extensions = null;
  while (p < tbs.end) {
    t = tlv(b, p, tbs.end);
    if (t.tag === 0xa3) extensions = expect(b, t.start, t.end, 0x30);
    else if (t.tag !== 0x81 && t.tag !== 0x82 && t.tag !== 0xa1 && t.tag !== 0xa2) throw new Malformed();
    p = t.end;
  }
  const sigAlg = expect(b, tbs.end, cert.end, 0x30);
  const sig = expect(b, sigAlg.end, cert.end, 0x03);
  if (sig.end !== cert.end) throw new Malformed();
  return { raw: b.subarray(0, cert.end), serial, notBefore, notAfter, exts: extensions ? readExtensions(b, extensions) : new Map() };
}

// UTCTime (YYMMDDHHMMSSZ, 1950-2049) or GeneralizedTime (YYYYMMDDHHMMSSZ), as a Date.
function asn1Time(b, t) {
  const s = String.fromCharCode(...b.subarray(t.start, t.end));
  let m;
  if (t.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
    const yy = +m[1];
    return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (t.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
    return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  throw new Malformed();
}

// extnID (dotted) -> { critical, value: [start, end) of the extnValue OCTET STRING's contents }
function readExtensions(b, seq) {
  const out = new Map();
  for (let p = seq.start; p < seq.end;) {
    const ext = expect(b, p, seq.end, 0x30);
    const oid = expect(b, ext.start, ext.end, 0x06);
    let q = oid.end;
    let t = tlv(b, q, ext.end);
    let critical = false;
    if (t.tag === 0x01) { critical = b[t.start] !== 0; q = t.end; t = tlv(b, q, ext.end); }
    if (t.tag !== 0x04) throw new Malformed();
    out.set(oidString(b.subarray(oid.start, oid.end)), { critical, start: t.start, end: t.end });
    p = ext.end;
  }
  return out;
}
function oidString(o) {
  const parts = [Math.floor(o[0] / 40), o[0] % 40];
  let v = 0;
  for (let i = 1; i < o.length; i++) { v = v * 128 + (o[i] & 0x7f); if (!(o[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// OpenSSL's ASN1_TIME_print, as node hands it back: "Mar  6 00:00:00 2008 GMT" (the day space-padded).
function opensslTime(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

const hexUpper = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

// node's X509Certificate reads PEM first (the first CERTIFICATE, X509 CERTIFICATE or TRUSTED CERTIFICATE block),
// then DER; when neither reads, the error is PEM's "no start line".
function certificateDer(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let m;
  while ((m = re.exec(text))) {
    if (!CERT_LABELS.includes(m[1])) continue;
    const der = new Uint8Array(Buffer.from(m[2].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
    try { return parseCertificate(der); } catch (e) { if (e instanceof Malformed) throw asn1Error(e.reason); throw e; }
  }
  try { return parseCertificate(bytes); } catch (e) { if (e instanceof Malformed) throw noStartLine(); throw e; }
}

function wall(name) {
  return () => {
    throw new Error(`node-shim: crypto.X509Certificate ${name} not implemented (it reads only the certificate's own `
      + 'bytes: raw, serialNumber, fingerprint256, validity, ca)');
  };
}

const kCert = Symbol('x509');
class X509Certificate {
  constructor(buffer) {
    let bytes;
    if (typeof buffer === 'string') bytes = new Uint8Array(Buffer.from(buffer, 'utf8'));
    else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else throw invalidArgType('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, or DataView', buffer);
    const c = certificateDer(bytes);
    this[kCert] = { ...c, raw: Buffer.from(c.raw) };
  }
  get raw() { return Buffer.from(this[kCert].raw); }
  get serialNumber() {
    const s = hexUpper(this[kCert].serial).replace(/^(00)+/, '');
    return s === '' ? '0' : s;   // BN_bn2hex: a zero serial is "0"
  }
  get fingerprint256() { return hexUpper(digestChunks('sha256', [this[kCert].raw])).replace(/(..)(?!$)/g, '$1:'); }
  get validFrom() { return opensslTime(this[kCert].notBefore); }
  get validTo() { return opensslTime(this[kCert].notAfter); }
  get validFromDate() { return new Date(this[kCert].notBefore.getTime()); }
  get validToDate() { return new Date(this[kCert].notAfter.getTime()); }
  // OpenSSL's X509_check_ca() === 1, as node answers `ca`: basicConstraints cA TRUE, and keyCertSign among the key
  // usages when the certificate names any.
  get ca() {
    const { exts, raw } = this[kCert];
    const ku = exts.get('2.5.29.15');
    if (ku) {
      const bits = expect(raw, ku.start, ku.end, 0x03);
      if (bits.end - bits.start < 2 || !(raw[bits.start + 1] & 0x04)) return false;
    }
    const bc = exts.get('2.5.29.19');
    if (!bc) return false;
    const seq = expect(raw, bc.start, bc.end, 0x30);
    if (seq.start === seq.end) return false;
    const first = tlv(raw, seq.start, seq.end);
    return first.tag === 0x01 && raw[first.start] !== 0;
  }
  toString() {
    const b64 = this[kCert].raw.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  }
  toJSON() { return this.toString(); }
}
for (const name of ['subject', 'issuer', 'subjectAltName', 'infoAccess', 'keyUsage', 'issuerCertificate', 'fingerprint',
  'fingerprint512', 'signatureAlgorithm', 'signatureAlgorithmOid', 'publicKey']) {
  Object.defineProperty(X509Certificate.prototype, name, { get: wall(name), configurable: true, enumerable: false });
}
for (const name of ['checkHost', 'checkEmail', 'checkIP', 'checkIssued', 'checkPrivateKey', 'verify', 'toLegacyObject']) {
  Object.defineProperty(X509Certificate.prototype, name, { value: wall(`${name}()`), writable: true, configurable: true, enumerable: false });
}

module.exports = { X509Certificate };

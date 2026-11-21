'use strict';
// node:tls — the -p boot reads tls.getCACertificates()/tls.rootCertificates at
// HTTP-client setup. The round-trip targets http://127.0.0.1 (the mock), so no
// TLS handshake and no CA validation actually occur on this path. Characterized
// by test/node-shim-net.test.cjs (tls row) and test/tls-cacert-pem.test.cjs.
//
// rootCertificates/getCACertificates('default'|'bundled'): the engine ALREADY
// vendors and ALREADY trusts a real, current Mozilla CA bundle for its own TLS
// (mbedtls's TLSTcp socket class + every libwebsockets https:///wss://
// connection fetch() makes — see spike/quickjs/vendor/txiki.js/src/cacert.c,
// mod_tls.c, lws-utils.c). It was simply never exposed to JS — this shim's own
// surface was the gap, not the engine. scripts/extract-cacert-pem.mjs pulls
// that SAME bundle out of cacert.c (byte-for-byte what real HTTPS in this
// engine already verifies against, not a separately-sourced or invented set)
// into the sibling asset tls-cacert.pem, which libexec/quaude-blobulate.js sweeps
// into a blobulated quaude verbatim (no extension filter — see its `collect()`).
// Re-run that script whenever cacert.c is refreshed by txiki.js's own
// scripts/update-ca-bundle.sh; test/tls-cacert-pem.test.cjs fails loudly if
// the shipped .pem drifts from cacert.c's current content.
//
// getCACertificates('system'|'extra'): honestly EMPTY — no real OS trust-store
// (macOS Keychain / Linux system bundle) or NODE_EXTRA_CA_CERTS integration
// exists here. The bundle's own CA-loading code (cli.cjs's `TQ`) already
// tolerates an empty/unavailable system store and falls back to the bundled
// set, so this does not regress the -p path; it only means a caller that
// SPECIFICALLY wants OS-trust-store certs gets none, same as before.
//
// Socket surface (connect/createServer/TLSSocket/createSecureContext) is NOT
// implemented — the transport is native fetch — and throws a branded wall if
// actually used (never on the -p path).
const FSS = globalThis.__tjs_fs_sync;

// Read the sibling PEM asset, blobulated-or-not. Mirrors loader.cjs's own
// __vfsGet-then-FSS pattern (not reused directly: __nodeShim only exports the
// TEXT-decoding readTextSync, and by the time this module can reference it,
// __dirname already gives the right VFS-or-real path — /quaude/node-shim/
// modules/tls-cacert.pem when blobulated, the real sibling path otherwise — see
// loader.cjs's evalModule(), which derives __dirname from the same SHIM_DIR
// this module itself was loaded from).
function readSiblingText(name) {
  const p = __dirname + '/' + name;
  if (globalThis.__quaudeVFS && p.startsWith('/quaude/')) {
    const vb = globalThis.__quaudeVFS.files.get(p.slice(8));
    if (vb) return new TextDecoder().decode(vb);
  }
  const fd = FSS.open(p, 'r');
  try {
    const size = FSS.fstat(fd).size;
    const ab = FSS.read(fd, size, 0);
    return new TextDecoder().decode(new Uint8Array(ab));
  } finally { FSS.close(fd); }
}

// Node's per-entry shape (verified against host node v24/v26): each array
// element is one "-----BEGIN CERTIFICATE-----\n<base64 lines>\n-----END
// CERTIFICATE-----" block, NO trailing newline after the END line.
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

let _bundled; // lazy + memoized, like node's own cacheBundledRootCertificates
function loadBundled() {
  if (_bundled) return _bundled;
  try {
    const text = readSiblingText('tls-cacert.pem');
    _bundled = Object.freeze(text.match(CERT_BLOCK_RE) || []);
  } catch {
    // No sibling asset reachable (e.g. a dev tree that hasn't run
    // scripts/extract-cacert-pem.mjs yet) — fail LOUD-ISH via an empty
    // result rather than throwing, matching this file's pre-existing
    // fail-soft contract for the -p mock-http boot path, but never silently
    // fabricate certificate data.
    _bundled = Object.freeze([]);
  }
  return _bundled;
}

const CA_TYPES = new Set(['default', 'bundled', 'system', 'extra']);
function getCACertificates(type) {
  const t = type === undefined ? 'default' : type;
  if (!CA_TYPES.has(t)) {
    throw Object.assign(
      new TypeError(`The argument 'type' is invalid. Received '${type}'`),
      { code: 'ERR_INVALID_ARG_VALUE' });
  }
  if (t === 'default' || t === 'bundled') return loadBundled();
  return []; // 'system' / 'extra': honestly unimplemented, see header
}

function unimplemented(name) {
  return function () { throw new Error(`node-shim: tls.${name} not implemented (fetch is the -p transport; the mock path is plain http)`); };
}
const SOCKET_API = ['connect', 'createServer', 'TLSSocket', 'Server', 'checkServerIdentity'];

// createSecureContext({ ca }), as NATIVE answers it (measured in 2.1.330's Bun with the BUN_OPTIONS preload
// oracle; recorded rows: test/fixtures/tls-secure-context-native.json). Node accepts any string or bytes here
// unparsed; native does not, and native is the reference. 2.1.330's CA-trust builder asks this whether the
// NODE_EXTRA_CA_CERTS file loads as one entry (`createSecureContext({ca:[file]})`); when it throws "Invalid CA",
// the bundle warns that it "cannot load ... as one CA list entry" and keeps only the blocks that load one by one.
// Accepting what native refuses would trust MORE than native does, and would skip that per-block filter.
//
// What native does, row by row:
// - options that are not an object (a string, a number), null or undefined: no options. A falsy `ca` (undefined,
//   null, false, 0, ''): no ca. Unknown keys are ignored, as node and native ignore them.
// - `ca` (or each element of an array `ca`) must be a string, Buffer, TypedArray or DataView, every element checked
//   before any is read: ERR_INVALID_ARG_TYPE otherwise.
// - each element is read as PEM, block by block (BEGIN/END lines, leading and trailing whitespace ignored, text
//   between blocks skipped). A block is bad when it has no matching END, its body is not whole base64 (a header
//   line, a stray BEGIN, missing padding, nothing at all), or, for a CERTIFICATE / X509 CERTIFICATE / TRUSTED
//   CERTIFICATE block, its DER is not one Certificate SEQUENCE {SEQUENCE, SEQUENCE, BIT STRING} filling the block
//   exactly (truncated, or a byte left over). Any other label (a key) is decoded but not parsed, and not counted.
//   Reading stops at the first bad block: the element is refused unless a certificate was read before it. An
//   element with no block at all (empty, whitespace, garbage) is refused. Refused = Error code ERR_BORINGSSL,
//   message "Invalid CA".
// This decides only whether the context is made; the engine's own TLS still verifies with mbedtls, whose parser
// the bootstrap's NODE_EXTRA_CA_CERTS path consults (libexec/quaude-bootstrap.mjs extraCaBundle). Options this
// context could not honour (a certificate, a key, ciphers...) still meet the wall: accepting them would lie.
class SecureContext { constructor() { this.context = {}; } }
const SECURE_CONTEXT_WALLED = ['cert', 'key', 'pfx', 'passphrase', 'ciphers', 'ecdhCurve', 'dhparam', 'crl',
  'honorCipherOrder', 'secureOptions', 'secureProtocol', 'minVersion', 'maxVersion', 'sigalgs', 'privateKeyEngine',
  'privateKeyIdentifier', 'clientCertEngine', 'sessionIdContext', 'ticketKeys', 'sessionTimeout',
  'allowPartialTrustChain'];
const CERT_LABELS = new Set(['CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE']);
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// One DER TLV at b[i]: { tag, start (of contents), end }, or null when it runs past `lim`.
function tlv(b, i, lim) {
  if (i + 2 > lim) return null;
  const tag = b[i];
  let len = b[i + 1]; let p = i + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > lim) return null;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + b[p++];
  }
  return p + len > lim ? null : { tag, start: p, end: p + len };
}
// Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, signatureAlgorithm SEQUENCE, signature BIT STRING },
// filling the block exactly (a TRUSTED CERTIFICATE may carry one trailing aux SEQUENCE).
function isCertificateDer(b, trusted) {
  const outer = tlv(b, 0, b.length);
  if (!outer || outer.tag !== 0x30) return false;
  let i = outer.start;
  for (const want of [0x30, 0x30, 0x03]) {
    const t = tlv(b, i, outer.end);
    if (!t || t.tag !== want) return false;
    i = t.end;
  }
  if (i !== outer.end) return false;
  if (outer.end === b.length) return true;
  const aux = trusted && tlv(b, outer.end, b.length);
  return !!aux && aux.tag === 0x30 && aux.end === b.length;
}
// Whether native loads one `ca` element (above).
function caEntryLoads(text) {
  const lines = text.split('\n').map((l) => l.trim());
  let certs = 0; let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^-----BEGIN (.+)-----$/.exec(lines[i]);
    if (!m) continue;
    blocks++;
    const end = lines.indexOf(`-----END ${m[1]}-----`, i + 1);
    const body = end < 0 ? null : lines.slice(i + 1, end).join('');
    let ok = body !== null && body !== '' && B64.test(body);
    if (ok && CERT_LABELS.has(m[1])) {
      ok = isCertificateDer(Buffer.from(body, 'base64'), m[1] === 'TRUSTED CERTIFICATE');
      if (ok) certs++;
    }
    if (!ok) return certs > 0;
    i = end;
  }
  return blocks > 0;
}
function createSecureContext(options) {
  const NE = require('../internal/node-errors.cjs');
  if (options === null || typeof options !== 'object') return new SecureContext();
  for (const k of SECURE_CONTEXT_WALLED) {
    if (options[k] !== undefined) throw new Error(`node-shim: tls.createSecureContext({${k}}) not implemented (only the ca option is taken)`);
  }
  const ca = options.ca;
  if (!ca) return new SecureContext();
  const entries = Array.isArray(ca) ? ca : [ca];
  for (const v of entries) {
    if (typeof v !== 'string' && !ArrayBuffer.isView(v)) {
      throw NE.invalidArgType('The "options.ca" property must be of type string or an instance of Buffer, TypedArray, or DataView', v);
    }
  }
  for (const v of entries) {
    const text = typeof v === 'string' ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1');
    if (!caEntryLoads(text)) throw Object.assign(new Error('Invalid CA'), { code: 'ERR_BORINGSSL' });
  }
  return new SecureContext();
}

const tls = {
  getCACertificates,
  createSecureContext,
  SecureContext,
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
};
// A lazy getter (like node's own), so a caller that never touches
// rootCertificates never pays for the sibling-file read + PEM split.
Object.defineProperty(tls, 'rootCertificates', { get: loadBundled, enumerable: true, configurable: false });
for (const n of SOCKET_API) tls[n] = unimplemented(n);
tls.default = tls;
module.exports = tls;

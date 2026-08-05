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
// into the sibling asset tls-cacert.pem, which libexec/quaude-fuse.js sweeps
// into a fused quaude verbatim (no extension filter — see its `collect()`).
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

// Read the sibling PEM asset, fused-or-not. Mirrors loader.cjs's own
// __vfsGet-then-FSS pattern (not reused directly: __nodeShim only exports the
// TEXT-decoding readTextSync, and by the time this module can reference it,
// __dirname already gives the right VFS-or-real path — /quaude/node-shim/
// modules/tls-cacert.pem when fused, the real sibling path otherwise — see
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
const SOCKET_API = ['connect', 'createServer', 'createSecureContext', 'TLSSocket', 'Server', 'checkServerIdentity'];

const tls = {
  getCACertificates,
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
};
// A lazy getter (like node's own), so a caller that never touches
// rootCertificates never pays for the sibling-file read + PEM split.
Object.defineProperty(tls, 'rootCertificates', { get: loadBundled, enumerable: true, configurable: false });
for (const n of SOCKET_API) tls[n] = unimplemented(n);
tls.default = tls;
module.exports = tls;

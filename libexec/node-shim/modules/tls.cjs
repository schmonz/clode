'use strict';
// node:tls — the -p boot reads tls.getCACertificates()/tls.rootCertificates at
// HTTP-client setup. The round-trip targets http://127.0.0.1 (the mock), so no
// TLS handshake and no CA validation actually occur on this path. Characterized
// by test/node-shim-net.test.cjs (tls row).
//
// DIVERGENCE (loud, deferred): this tjs build ships no bundled Mozilla CA store
// reachable from JS, so getCACertificates()/rootCertificates return an EMPTY
// array (host node returns ~120 PEMs). That is correct for the plain-http mock
// path; a real HTTPS round-trip needing CA validation is the documented
// https-fallback wall (wire the mock CA via the brief then). The socket surface
// (connect/createServer/TLSSocket/createSecureContext) is NOT implemented — the
// transport is native fetch — and throws a branded wall if actually used (never
// on the -p path).
function getCACertificates(_type) { return []; }

function unimplemented(name) {
  return function () { throw new Error(`node-shim: tls.${name} not implemented (fetch is the -p transport; the mock path is plain http)`); };
}
const SOCKET_API = ['connect', 'createServer', 'createSecureContext', 'TLSSocket', 'Server', 'checkServerIdentity'];

const tls = {
  getCACertificates,
  rootCertificates: [],
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
};
for (const n of SOCKET_API) tls[n] = unimplemented(n);
tls.default = tls;
module.exports = tls;

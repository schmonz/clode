'use strict';
// node:dns (+ dns/promises) — the -p bundle captures both in transport modules.
// The round-trip targets a literal IP (127.0.0.1), and txiki's native `fetch`
// does its own resolution, so dns.lookup is not on the request hot path here.
// lookup() is implemented for the cases that CAN arise without a resolver:
// IPv4/IPv6 literals and 'localhost'. Characterized by
// test/node-shim-core.test.cjs (dns row).
//
// DIVERGENCE (loud, deferred): resolving a non-literal, non-localhost hostname
// needs a real resolver (txiki exposes no JS DNS resolver primitive today), so
// lookup() of such a name throws a branded wall rather than guessing; resolve*/
// reverse are likewise branded-unimplemented. The -p mock path never hits these.
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /:/;

function familyOf(addr) { return IPV6.test(addr) ? 6 : 4; }

function resolveLiteral(hostname) {
  if (hostname === 'localhost') return { address: '127.0.0.1', family: 4 };
  if (IPV4.test(hostname)) return { address: hostname, family: 4 };
  if (IPV6.test(hostname)) return { address: hostname, family: 6 };
  return null;
}

function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const hit = resolveLiteral(hostname);
  if (!hit) {
    const e = new Error(`node-shim: dns.lookup('${hostname}') not implemented (no JS resolver in tjs; the -p mock path uses a literal IP)`);
    if (cb) return cb(e);
    throw e;
  }
  const all = options && options.all;
  if (cb) return queueMicrotask(() => cb(null, all ? [hit] : hit.address, all ? undefined : hit.family));
}

async function pLookup(hostname, options = {}) {
  const hit = resolveLiteral(hostname);
  if (!hit) throw new Error(`node-shim: dns.promises.lookup('${hostname}') not implemented (no JS resolver in tjs; the -p mock path uses a literal IP)`);
  return options && options.all ? [hit] : { address: hit.address, family: hit.family };
}

function unimplemented(name) {
  return function () { throw new Error(`node-shim: dns.${name} not implemented (no JS resolver in tjs)`); };
}
const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt',
  'resolveSrv', 'resolveNs', 'resolveCname', 'reverse'];

const promises = { lookup: pLookup };
for (const n of RESOLVERS) promises[n] = unimplemented(n);

const dns = { lookup, promises };
for (const n of RESOLVERS) dns[n] = unimplemented(n);
dns.default = dns;
module.exports = dns;

'use strict';
// node:https — the same client as node:http (see http.cjs, "client" section)
// with the TLS defaults applied: protocol https:, default port 443, and the
// connection made with tjs.connect('tls', ...) against the engine's own
// embedded Mozilla CA bundle unless the caller supplies `ca`.
//
// The proxy-agent stack and some SDK config read `https.Agent` (a subclass of
// http.Agent), which is a real constructor here but does NOT pool sockets —
// see http.cjs for the full divergence list. Characterized by
// test/node-shim-http.test.cjs (surface) and test/node-shim-http-client.test.cjs
// (behaviour, differentially against host node).
//
// WHY the client exists: measured reachability, not a guess — with
// CLAUDE_CODE_USE_BEDROCK=1 the AWS SDK's @smithy/node-http-handler issues a
// real https.request to bedrock.<region>.amazonaws.com. The full measurement is
// recorded in http.cjs's header.
const http = require('node:http');

class Agent extends http.Agent {
  constructor(options = {}) {
    super(options);
    this.protocol = 'https:';
    this.defaultPort = 443;
  }
}

const globalAgent = new Agent();
// Marked as global for the same reason http's is: node applies the proxy
// environment to the global agent, and a caller may name it explicitly
// (`agent: https.globalAgent` proxies; `agent: new https.Agent()` does not).
Object.defineProperty(globalAgent, '_shimGlobalAgent', { value: true, enumerable: false });

const { ClientRequest, normalizeArgs } = http._internals;

function request(url, options, cb) {
  const [opts, done] = normalizeArgs(url, options, cb, { protocol: 'https:', defaultPort: 443 });
  // A caller that passed only `options` (no URL) may not have set protocol;
  // node:https forces it, and an explicit http: here would silently downgrade
  // the connection to plaintext, so reject it by name instead.
  if (opts.protocol && opts.protocol !== 'https:') {
    throw Object.assign(
      new Error(`Protocol "${opts.protocol}" not supported. Expected "https:"`),
      { code: 'ERR_INVALID_PROTOCOL' });
  }
  opts.protocol = 'https:';
  return new ClientRequest(opts, done);
}

function get(url, options, cb) {
  const req = request(url, options, cb);
  req.end();
  return req;
}

module.exports = {
  Agent, globalAgent, request, get, ClientRequest: http.ClientRequest,
  STATUS_CODES: http.STATUS_CODES, METHODS: http.METHODS,
};
module.exports.default = module.exports;

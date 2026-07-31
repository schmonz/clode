'use strict';
// node:https — same rationale as node:http (see http.cjs). The proxy-agent stack
// and some SDK config read `https.Agent` (a subclass of http.Agent). On the -p
// path the transport is native `fetch`; https.request/get delegate to http.cjs's
// SAME traced ClientRequest implementation (via http._makeClient), just with a
// 'https:' default protocol/port — instrumenting the shared path once rather
// than duplicating it, per the CLODE_SHIM_TRACE diagnostic in http.cjs (see its
// header note for the darwin-ppc/10.4 -p startup-hang investigation this
// serves). Characterized by test/node-shim-http.test.cjs.
const http = require('node:http');

class Agent extends http.Agent {
  constructor(options = {}) {
    super(options);
    this.protocol = 'https:';
  }
}

const globalAgent = new Agent();
const { request, get } = http._makeClient('https:');

module.exports = {
  Agent, globalAgent, STATUS_CODES: http.STATUS_CODES, METHODS: http.METHODS,
  request, get, ClientRequest: http.ClientRequest,
};
module.exports.default = module.exports;

'use strict';
// node:https — same rationale as node:http (see http.cjs). The proxy-agent stack
// and some SDK config read `https.Agent` (a subclass of http.Agent). On the -p
// path the transport is native `fetch`; https.request/get are NOT implemented
// (DIVERGENCE, deferred — wire test-first if a boot issues node:https requests).
// Characterized by test/node-shim-http.test.cjs.
const http = require('node:http');

class Agent extends http.Agent {
  constructor(options = {}) {
    super(options);
    this.protocol = 'https:';
  }
}

const globalAgent = new Agent();

module.exports = { Agent, globalAgent, STATUS_CODES: http.STATUS_CODES, METHODS: http.METHODS };
module.exports.default = module.exports;

'use strict';
// node:http — the -p bundle's proxy-agent stack (`agent-base`,
// `http-proxy-agent`) defines `class X extends require('http').Agent` at load,
// so http.Agent must be a REAL constructor (subclassable + instantiable). On the
// -p path the transport is txiki's native `fetch` and no proxy is configured, so
// these agents are DEFINED but never instantiated/used. Characterized by
// test/node-shim-http.test.cjs.
//
// DIVERGENCE (loud, deferred): the request/response surface (http.request /
// http.get / http.Server) is NOT implemented — the round-trip never falls back
// to node:http (fetch is the path). Agent is a minimal-but-real connection-pool
// bookkeeping object (the fields agent-base's subclass reads via super()), not
// Node's full socket-pooling Agent. A boot that actually issues node:http
// requests is a genuine later wall — wire request()/ClientRequest over txiki
// sockets test-first then.
const { EventEmitter } = require('node:events');

class Agent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options || {};
    this.protocol = 'http:';
    this.maxSockets = this.options.maxSockets ?? Infinity;
    this.maxFreeSockets = this.options.maxFreeSockets ?? 256;
    this.maxTotalSockets = this.options.maxTotalSockets ?? Infinity;
    this.keepAlive = !!this.options.keepAlive;
    this.sockets = {};
    this.freeSockets = {};
    this.requests = {};
  }
  destroy() {}
  getName() { return 'localhost:'; }
}

const globalAgent = new Agent();

// The tiny status/method tables the bundle occasionally reads; real values.
const STATUS_CODES = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE'];

module.exports = { Agent, globalAgent, STATUS_CODES, METHODS };
module.exports.default = module.exports;

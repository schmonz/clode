'use strict';
// node:http — the -p bundle's proxy-agent stack (`agent-base`,
// `http-proxy-agent`) defines `class X extends require('http').Agent` at load,
// so http.Agent must be a REAL constructor (subclassable + instantiable). On the
// -p path the transport is txiki's native `fetch` and no proxy is configured, so
// these agents are DEFINED but never instantiated/used. Characterized by
// test/node-shim-http.test.cjs.
//
// DIVERGENCE (loud, deferred): the CLIENT surface (http.request / http.get) is
// NOT implemented — the round-trip never falls back to node:http (fetch is the
// path). Agent is a minimal-but-real connection-pool bookkeeping object (the
// fields agent-base's subclass reads via super()), not Node's full
// socket-pooling Agent. A boot that actually issues node:http requests is a
// genuine later wall — wire request()/ClientRequest over txiki sockets
// test-first then.
//
// The SERVER surface (createServer/Server/IncomingMessage/ServerResponse) IS
// implemented, minimally, over tjs.listen('tcp', ...): `clode build` running
// under the fused native builder smokes its quaude against an in-process canned
// Messages mock (libexec/clode-fuse.cjs startPongMock), which needs a real
// local HTTP server. Scope = that mock's surface, characterized differentially
// vs host node (test/node-shim-http-server.test.cjs). Documented divergences:
//   - every response is Connection: close (no keep-alive, no pipelining); a
//     Content-Length is computed when the handler set none (node would use
//     chunked TE) — equivalent framing for whole-body responses;
//   - chunked REQUEST bodies are a loud wall (local mock clients send
//     Content-Length);
//   - res.write() buffers; bytes go out on end() (no incremental streaming).
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

/* ---- server ---------------------------------------------------------------- */

class IncomingMessage extends EventEmitter {
  constructor(method, url, headers, httpVersion) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;       // lower-cased keys, like node
    this.httpVersion = httpVersion;
    this.complete = false;
  }
}

class ServerResponse extends EventEmitter {
  // finish(head, bodyChunks) is wired by the connection handler: it owns the
  // socket write + close. Response bytes leave on end() only (see header note).
  constructor(finish) {
    super();
    this._finish = finish;
    this._headers = new Map();    // key: lower-case; value: [origCase, value]
    this._chunks = [];
    this.statusCode = 200;
    this.statusMessage = '';
    this.headersSent = false;
    this.finished = false;
  }
  setHeader(name, value) { this._headers.set(String(name).toLowerCase(), [String(name), value]); return this; }
  getHeader(name) { const e = this._headers.get(String(name).toLowerCase()); return e && e[1]; }
  removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
  writeHead(status, message, headers) {
    if (typeof message === 'object' && message !== null) { headers = message; message = undefined; }
    this.statusCode = status;
    if (message !== undefined) this.statusMessage = message;
    for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
    this.headersSent = true;      // node marks headers committed at writeHead
    return this;
  }
  write(chunk, enc) {
    if (chunk != null) this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8') : Buffer.from(chunk));
    return true;
  }
  end(chunk, enc) {
    if (this.finished) return this;
    this.write(chunk, enc);
    this.finished = true;
    const body = Buffer.concat(this._chunks);
    // Frame: handler headers verbatim, plus Content-Length when absent, plus
    // Connection: close always (divergence: node would keep-alive + chunk).
    if (!this._headers.has('content-length') && !this._headers.has('transfer-encoding')) {
      this.setHeader('Content-Length', body.length);
    }
    this._headers.set('connection', ['Connection', 'close']);
    const msg = this.statusMessage || STATUS_CODES[this.statusCode] || '';
    let head = `HTTP/1.1 ${this.statusCode} ${msg}\r\n`;
    for (const [, [name, value]] of this._headers) {
      for (const v of Array.isArray(value) ? value : [value]) head += `${name}: ${v}\r\n`;
    }
    head += '\r\n';
    this._finish(head, body);
    this.emit('finish');
    return this;
  }
}

// One accepted TCPSocket: parse a single request, emit it, send the response,
// close. (Connection: close discipline means one request per connection.)
async function serveConnection(server, sock) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  try {
    const { readable, writable } = await sock.opened;
    const reader = readable.getReader();
    let buf = new Uint8Array(0);
    const more = async () => {
      const { value, done } = await reader.read();
      if (done || !value) return false;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf, 0); next.set(value, buf.length);
      buf = next;
      return true;
    };
    const headEnd = () => {
      for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
      }
      return -1;
    };
    while (headEnd() === -1) { if (!(await more())) { sock.close(); return; } }
    const he = headEnd();
    const headText = dec.decode(buf.subarray(0, he));
    let body = buf.subarray(he + 4);

    const lines = headText.split('\r\n');
    const [method, url, proto] = lines[0].split(' ');
    const headers = {};
    for (const line of lines.slice(1)) {
      const c = line.indexOf(':');
      if (c === -1) continue;
      const k = line.slice(0, c).trim().toLowerCase();
      const v = line.slice(c + 1).trim();
      headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
    }
    if (/chunked/i.test(headers['transfer-encoding'] || '')) {
      throw new Error('node-shim: http.Server chunked request bodies not implemented');
    }
    const want = parseInt(headers['content-length'] || '0', 10) || 0;
    while (body.length < want) {
      if (!(await more())) break;
      body = buf.subarray(he + 4);
    }

    const req = new IncomingMessage(method, url, headers, (proto || 'HTTP/1.1').replace(/^HTTP\//, ''));
    const res = new ServerResponse(async (head, respBody) => {
      const writer = writable.getWriter();
      const headBytes = enc.encode(head);
      const out = new Uint8Array(headBytes.length + respBody.length);
      out.set(headBytes, 0); out.set(respBody, headBytes.length);
      await writer.write(out);
      writer.releaseLock();
      sock.close();
    });
    server.emit('request', req, res);
    // Body events on a later tick, after the handler has attached listeners
    // (node also delivers asynchronously).
    setTimeout(() => {
      if (body.length) req.emit('data', Buffer.from(body));
      req.complete = true;
      req.emit('end');
    }, 0);
  } catch (e) {
    try { sock.close(); } catch { /* already gone */ }
    server.emit('clientError', e);
  }
}

class Server extends EventEmitter {
  constructor(handler) {
    super();
    if (handler) this.on('request', handler);
    this._listener = null;
    this._addr = null;
    this.listening = false;
  }
  // listen(port[, host][, cb]) — the signatures the local-mock use needs.
  listen(port = 0, host, cb) {
    if (typeof port === 'function') { cb = port; port = 0; host = undefined; }
    if (typeof host === 'function') { cb = host; host = undefined; }
    const bindHost = host || '0.0.0.0';
    (async () => {
      const listener = await tjs.listen('tcp', bindHost, port);
      const { readable, localAddress, localPort } = await listener.opened;
      this._listener = listener;
      this._addr = {
        address: localAddress,
        family: localAddress.includes(':') ? 'IPv6' : 'IPv4',
        port: localPort,
      };
      this.listening = true;
      this.emit('listening');
      if (cb) cb();
      const accept = readable.getReader();
      for (;;) {
        const { value: sock, done } = await accept.read();
        if (done || !this.listening) { if (sock) { try { sock.close(); } catch { /* */ } } break; }
        serveConnection(this, sock);
      }
    })().catch((e) => this.emit('error', e));
    return this;
  }
  address() { return this._addr; }
  close(cb) {
    this.listening = false;
    if (this._listener) { try { this._listener.close(); } catch { /* already closed */ } this._listener = null; }
    // Divergence: node's close(cb) waits for in-flight connections; ours fires
    // on the next tick (served connections close themselves after respond).
    if (cb) setTimeout(() => cb(null), 0);
    this.emit('close');
    return this;
  }
}

function createServer(options, handler) {
  if (typeof options === 'function') { handler = options; options = undefined; }
  return new Server(handler);
}

module.exports = {
  Agent, globalAgent, STATUS_CODES, METHODS,
  Server, IncomingMessage, ServerResponse, createServer,
};
module.exports.default = module.exports;

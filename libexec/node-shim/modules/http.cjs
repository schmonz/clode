'use strict';
// node:http — the -p bundle's proxy-agent stack (`agent-base`,
// `http-proxy-agent`) defines `class X extends require('http').Agent` at load,
// so http.Agent must be a REAL constructor (subclassable + instantiable). On the
// -p path the transport is txiki's native `fetch` and no proxy is configured, so
// these agents are DEFINED but never instantiated/used. Characterized by
// test/node-shim-http.test.cjs.
//
// The -p round-trip's normal transport is native `fetch`, not node:http — but
// http.request/http.get themselves ARE implemented below (a minimal,
// fetch-backed ClientRequest), wired for the CLODE_SHIM_TRACE investigation
// (see the "client request tracing" block near the bottom of this file): a
// darwin-ppc/10.4 -p startup hang was isolated to the mere PRESENCE of
// ~/.claude/.credentials.json, occurs BEFORE any API request, and the fetch
// tracer saw exactly ONE request for the whole hung run — meaning whatever
// hangs is NOT going through globalThis.fetch. The bundle's token-refresh
// path (refresh_token, oauth/token, gated on credentials existing) was the
// suspect, and Node HTTP clients commonly use node:http/https — a total
// blind spot while request()/get() didn't exist at all (no code to trace).
// Agent is a minimal-but-real connection-pool bookkeeping object (the fields
// agent-base's subclass reads via super()), not Node's full socket-pooling
// Agent — that divergence stands; only the request-issuing surface changed.
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

/* ---- client: request()/get(), opt-in tracing ------------------------------
 * CLODE_SHIM_TRACE=1 diagnostic (see header note): every terminal outcome of
 * a request — response, error, or an explicit abort — MUST log, because the
 * entire point is that an UNMATCHED `[http] ->` line names the request that
 * never settled. Read the flag from tjs.env (not process.env): this module
 * can load before globalThis.process is fully wired (loadBuiltin('process')
 * itself may pull in other builtins), and tjs.env is always the raw engine
 * env; same gate as modules/child_process.cjs's spawn tracing and the
 * loader's fetch tracer, so one env var controls all of them together.
 */
const TRACE = !!(globalThis.process && globalThis.process.env && globalThis.process.env.CLODE_SHIM_TRACE);
function trace() { if (TRACE) { try { console.error('[http]', ...arguments); } catch { /* best effort */ } } }

function headersToObject(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') headers.forEach((v, k) => { out[k] = v; });
  return out;
}

// Build the target URL from either `request(url[, options])` or the
// `request(options)` shape (node accepts both; the bundle's callers and this
// module's own tests exercise the options-object form). No attempt to merge
// a URL string WITH an options object's overrides — node's own merge rules
// are a rat's nest and no known caller here needs both at once (YAGNI).
function normalizeArgs(urlOrOptions, optionsOrCb, cb) {
  let urlArg, options, callback;
  if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
    urlArg = urlOrOptions;
    if (typeof optionsOrCb === 'function') { callback = optionsOrCb; options = {}; }
    else { options = optionsOrCb || {}; callback = cb; }
  } else {
    options = urlOrOptions || {};
    callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
  }
  return { urlArg, options, callback };
}

// A real (fetch-backed), minimal http.ClientRequest. Deliberately an
// EventEmitter with write/end rather than a full node:stream.Writable —
// matching this file's existing house style for ServerResponse above, and
// the bundle's known callers (agent-base et al.) don't need backpressure.
class ClientRequest extends EventEmitter {
  constructor(urlArg, options, callback) {
    super();
    this._method = (options && options.method) || 'GET';
    this._headers = Object.assign({}, options && options.headers);
    this._chunks = [];
    this._ended = false;
    this._aborted = false;
    this.destroyed = false;
    this.aborted = false;
    if (callback) this.once('response', callback);
    try {
      this._target = urlArg
        ? new URL(String(urlArg))
        : new URL(`${options.protocol || 'http:'}//${options.hostname || options.host || 'localhost'}` +
                  `${options.port ? ':' + options.port : ''}${options.path || '/'}`);
    } catch (e) {
      this._target = null;
      // Node defers a bad-URL failure to the next tick rather than throwing
      // synchronously out of request() — so a caller's `req.on('error', …)`
      // (attached right after request() returns, the universal idiom) still
      // catches it, instead of racing an unhandled synchronous throw.
      queueMicrotask(() => { if (!this.destroyed) { trace('xx (bad url)', this._method, String(e)); this.emit('error', e); } });
    }
  }
  setHeader(name, value) { this._headers[name] = value; return this; }
  getHeader(name) { return this._headers[name]; }
  removeHeader(name) { delete this._headers[name]; }
  // Cheap defensive stub: some HTTP-adjacent libraries (agent-base et al.)
  // call req.setTimeout(ms, cb) defensively even when no real per-request
  // timer is needed here; without it that call throws "not a function" and
  // takes down an otherwise-working caller. No timer is actually armed
  // (out of scope for this diagnostic) — this only keeps the call-site safe.
  setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
  write(chunk, encOrCb, cb) {
    if (typeof encOrCb === 'function') cb = encOrCb;
    if (chunk != null) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (typeof cb === 'function') queueMicrotask(cb);
    return true;
  }
  end(chunk, encOrCb, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    else if (typeof encOrCb === 'function') cb = encOrCb;
    if (chunk != null) this.write(chunk);
    if (typeof cb === 'function') queueMicrotask(cb);
    if (this._ended || !this._target) return this;
    this._ended = true;
    this._send();
    return this;
  }
  abort() {
    if (this._aborted) return;
    this._aborted = true; this.aborted = true; this.destroyed = true;
    trace('xx (aborted by caller)', this._method, this._target ? this._target.href : '(no url)');
    queueMicrotask(() => this.emit('abort'));
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) { trace('xx (destroyed)', this._method, this._target ? this._target.href : '(no url)', String(err)); queueMicrotask(() => this.emit('error', err)); }
    return this;
  }
  async _send() {
    const method = this._method;
    const url = this._target.href;
    // Identity (method + url) is repeated on EVERY line below — creation,
    // response, error, stream-end — so a hung run's log can be grepped for
    // an unmatched '->' to name the exact request that never settled.
    trace('->', method, url);
    let body;
    if (this._chunks.length) body = Buffer.concat(this._chunks);
    let res;
    try {
      res = await globalThis.fetch(url, { method, headers: this._headers, body });
    } catch (e) {
      // The terminal outcome that matters most for this investigation: a
      // connection that fails OUTRIGHT (refused/DNS/etc). If instead the
      // fetch() promise never settles at all, neither this line nor the
      // '<-' below prints — an unmatched '->' is itself the diagnostic.
      trace('xx', method, url, String(e));
      if (!this.destroyed) this.emit('error', e);
      return;
    }
    if (this._aborted || this.destroyed) { trace('<- (aborted, response dropped)', method, url); return; }
    trace('<-', method, url, 'status=', res.status);
    const im = new IncomingMessage(method, url, headersToObject(res.headers), '1.1');
    im.statusCode = res.status;
    im.statusMessage = STATUS_CODES[res.status] || '';
    this.emit('response', im);
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) im.emit('data', Buffer.from(value));
        }
      } else if (typeof res.arrayBuffer === 'function') {
        const ab = await res.arrayBuffer();
        if (ab && ab.byteLength) im.emit('data', Buffer.from(ab));
      }
      im.complete = true;
      trace('done', method, url);
      im.emit('end');
    } catch (e) {
      trace('xx (body)', method, url, String(e));
      im.emit('error', e);
    }
  }
}

// Factory so https.cjs can reuse this SAME traced implementation (with a
// different default protocol/port) instead of duplicating it — per the
// house instruction to instrument the shared path once.
function makeClient(defaultProtocol) {
  function request(urlOrOptions, optionsOrCb, cb) {
    const { urlArg, options, callback } = normalizeArgs(urlOrOptions, optionsOrCb, cb);
    const opts = urlArg ? options : Object.assign({ protocol: defaultProtocol }, options);
    return new ClientRequest(urlArg, opts, callback);
  }
  function get(urlOrOptions, optionsOrCb, cb) {
    const req = request(urlOrOptions, optionsOrCb, cb);
    req.end();
    return req;
  }
  return { request, get };
}

const { request, get } = makeClient('http:');

module.exports = {
  Agent, globalAgent, STATUS_CODES, METHODS,
  Server, IncomingMessage, ServerResponse, createServer,
  ClientRequest, request, get, _makeClient: makeClient,
};
module.exports.default = module.exports;

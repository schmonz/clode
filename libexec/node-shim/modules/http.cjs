'use strict';
// node:http — the -p bundle's proxy-agent stack (`agent-base`,
// `http-proxy-agent`) defines `class X extends require('http').Agent` at load,
// so http.Agent must be a REAL constructor (subclassable + instantiable). On the
// -p path the transport is txiki's native `fetch`, so those agents are usually
// DEFINED but never instantiated — usually, because with a proxy configured the
// bundle really does build one for the Bedrock backend. Characterized by
// test/node-shim-http.test.cjs.
//
// The CLIENT surface (request/get/ClientRequest) IS implemented, over
// tjs.connect('tcp'|'tls', ...) — see the "client" section below for the full
// divergence list. Agent remains a minimal-but-real connection-pool
// BOOKKEEPING object (the fields agent-base's subclass reads via super()), not
// Node's socket-pooling Agent: nothing here pools or reuses sockets, so an
// Agent's keepAlive/maxSockets are read for connect-time hints only.
//
// The client honours the PROXY environment on node's own terms (see the "proxy"
// section): before that it connected straight past HTTP(S)_PROXY without a word,
// which behind a monitoring or filtering proxy is a silent bypass, not just a
// missing feature. A proxy AGENT — the one shape where "Agent is bookkeeping
// only" would have quietly sent bytes somewhere the caller did not ask for — is
// honoured too, or refused by name.
//
// WHY the client exists now (measured 2026-08-22, not assumed). The client half
// was a documented wall on the premise that "the -p transport is fetch". That
// premise was tested by instrumenting the shim's http module with a logging
// throw, fusing a quaude, and driving real flows. Result:
//   - a plain `-p` turn, an interactive TUI boot, MCP over HTTP *and* SSE, and a
//     run with HTTP(S)_PROXY set reach node:http's client ZERO times. axios —
//     the bundle's only heavy node:http user under real Node (bootstrap,
//     event_logging, mcp-registry, metrics_enabled, datadog) — picks its XHR
//     adapter under tjs, because txiki DOES define a global XMLHttpRequest and
//     axios's adapter preference is ['xhr','http','fetch']. Those requests all
//     complete today (200/202/401 observed). So for the default Anthropic-API
//     backend the wall really was latent.
//   - the Bedrock backend is NOT latent. `CLAUDE_CODE_USE_BEDROCK=1` with no
//     static credentials drove 10 http.request calls to the EC2 instance
//     metadata service (169.254.169.254 /latest/api/token, /latest/meta-data/
//     iam/security-credentials/) from the AWS SDK's credential chain; with
//     static credentials it drove an https.request to
//     bedrock.<region>.amazonaws.com/inference-profiles from
//     @smithy/node-http-handler. Host node, same bundle, same env: identical
//     call sites, and off-EC2 it degrades to the clean "Could not load
//     credentials from any providers". quaude instead printed
//     "API Error: <nameless> is not a function" (QuickJS TypeErrors carry no
//     symbol name), and on an actual EC2 instance role Bedrock could not work
//     at all.
// So: reachable, on a supported backend, with a worse-than-node failure mode.
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
//   - chunked REQUEST bodies now work — the client half needed a chunked
//     decoder anyway, and both faces share it (see "shared message parsing");
//   - res.write() buffers; bytes go out on end() (no incremental streaming).
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

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
// Node applies the proxy environment to the GLOBAL agent only (measured below,
// in the proxy section): `agent: new http.Agent()` goes direct, `agent:
// http.globalAgent` proxies. A caller can hand us the global agent explicitly,
// so "is this the global one?" has to be a property of the object rather than
// `agent == null`. node:https marks its own globalAgent the same way.
Object.defineProperty(globalAgent, '_shimGlobalAgent', { value: true, enumerable: false });

// The tiny status/method tables the bundle occasionally reads; real values.
const STATUS_CODES = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE'];

/* ---- shared message parsing ------------------------------------------------
 * ONE parser serves both faces. A request head and a response head differ only
 * in their start line; the body framing rules (Content-Length / chunked /
 * read-until-EOF) are identical, and getting chunked decoding subtly wrong in
 * two places is exactly the failure mode this file's history warns about. So:
 * splitHead + parseHeaderLines + BodyDecoder are used by serveConnection (the
 * server) and by ClientRequest (the client) alike. Adding the client is what
 * retired the server's old "chunked REQUEST bodies not implemented" wall — the
 * decoder had to exist anyway, and a second copy would have been the bug. */

// Index of the CRLFCRLF that terminates the head, or -1. Byte scan (no decode):
// header bytes are latin1-safe but a body may be arbitrary binary.
function headEndIndex(buf, from = 0) {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

// Header lines -> node's two views: `headers` (lower-cased keys, duplicates
// joined per node's rules) and `rawHeaders` (flat [name, value, name, value]
// in wire order, original case). Node joins repeated headers with ', ' except
// set-cookie (an array) and a discard-list that keeps only the first.
const SINGLE_VALUE = new Set([
  'age', 'authorization', 'content-length', 'content-type', 'etag', 'expires',
  'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified',
  'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after',
  'server', 'user-agent',
]);
function parseHeaderLines(lines) {
  const headers = Object.create(null);
  const rawHeaders = [];
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c === -1) continue;
    const name = line.slice(0, c).trim();
    const value = line.slice(c + 1).trim();
    const k = name.toLowerCase();
    rawHeaders.push(name, value);
    if (k === 'set-cookie') { (headers[k] || (headers[k] = [])).push(value); continue; }
    if (k in headers) { if (!SINGLE_VALUE.has(k)) headers[k] = `${headers[k]}, ${value}`; continue; }
    headers[k] = value;
  }
  return { headers, rawHeaders };
}

// Split a complete head block into its start line and header lines.
function splitHead(headText) {
  const lines = headText.split('\r\n');
  return { startLine: lines[0] || '', headerLines: lines.slice(1) };
}

// Decide body framing from a parsed head, node's rules. `mode`:
//   'none'    — no body at all (HEAD response, 1xx/204/304, or a request with
//               neither Content-Length nor Transfer-Encoding)
//   'length'  — exactly `length` bytes
//   'chunked' — RFC 7230 chunked transfer coding
//   'eof'     — read until the peer closes (responses only; a request without
//               framing has no body, it does not run to EOF)
function bodyFraming(headers, { isResponse, statusCode, requestMethod }) {
  if (isResponse) {
    if (requestMethod === 'HEAD' || statusCode === 204 || statusCode === 304
        || (statusCode >= 100 && statusCode < 200)) return { mode: 'none', length: 0 };
  }
  const te = String(headers['transfer-encoding'] || '');
  if (te) {
    if (!/(^|,)\s*chunked\s*$/i.test(te)) {
      throw Object.assign(
        new Error(`node-shim: unsupported Transfer-Encoding '${te}' (only 'chunked' is implemented)`),
        { code: 'ERR_SHIM_HTTP_UNSUPPORTED_TE' });
    }
    return { mode: 'chunked', length: 0 };
  }
  if (headers['content-length'] !== undefined) {
    const n = Number(headers['content-length']);
    if (!Number.isInteger(n) || n < 0) {
      throw Object.assign(new Error(`node-shim: invalid Content-Length '${headers['content-length']}'`),
        { code: 'ERR_SHIM_HTTP_BAD_CONTENT_LENGTH' });
    }
    return { mode: 'length', length: n };
  }
  return isResponse ? { mode: 'eof', length: 0 } : { mode: 'none', length: 0 };
}

// Incremental body decoder. Feed it bytes with push(); it returns the decoded
// body bytes produced so far and whether the message is complete. eof() reports
// whether the stream ended in a legal place.
class BodyDecoder {
  constructor(mode, length) {
    this.mode = mode;
    this.remaining = mode === 'length' ? length : 0;
    this.done = mode === 'none' || (mode === 'length' && length === 0);
    this._pending = new Uint8Array(0);      // chunked: bytes not yet parsed
    this._state = 'size';                   // chunked: 'size' | 'data' | 'crlf' | 'trailer'
    this._need = 0;
  }
  // -> array of Uint8Array body slices (possibly empty)
  push(bytes) {
    if (this.done || !bytes || !bytes.length) return [];
    if (this.mode === 'eof') return [bytes];
    if (this.mode === 'length') {
      const take = Math.min(this.remaining, bytes.length);
      this.remaining -= take;
      if (this.remaining === 0) this.done = true;
      return take ? [bytes.subarray(0, take)] : [];
    }
    if (this.mode === 'chunked') return this._pushChunked(bytes);
    return [];
  }
  _pushChunked(bytes) {
    const merged = new Uint8Array(this._pending.length + bytes.length);
    merged.set(this._pending, 0); merged.set(bytes, this._pending.length);
    let buf = merged;
    const out = [];
    for (;;) {
      if (this._state === 'size') {
        const nl = indexOfCRLF(buf);
        if (nl === -1) break;
        const line = latin1(buf.subarray(0, nl));
        // "<hex>[;chunk-ext]" — extensions are legal and ignored, as node does.
        const hex = line.split(';')[0].trim();
        const size = parseInt(hex, 16);
        if (!(size >= 0) || Number.isNaN(size)) {
          throw Object.assign(new Error(`node-shim: malformed chunk size '${line}'`),
            { code: 'ERR_SHIM_HTTP_BAD_CHUNK' });
        }
        buf = buf.subarray(nl + 2);
        if (size === 0) { this._state = 'trailer'; continue; }
        this._need = size;
        this._state = 'data';
        continue;
      }
      if (this._state === 'data') {
        if (!buf.length) break;
        const take = Math.min(this._need, buf.length);
        out.push(buf.subarray(0, take));
        buf = buf.subarray(take);
        this._need -= take;
        if (this._need === 0) this._state = 'crlf';
        continue;
      }
      if (this._state === 'crlf') {
        if (buf.length < 2) break;
        buf = buf.subarray(2);              // the CRLF after a chunk's data
        this._state = 'size';
        continue;
      }
      // 'trailer': consume trailer lines until the terminating empty line.
      const nl = indexOfCRLF(buf);
      if (nl === -1) break;
      const line = latin1(buf.subarray(0, nl));
      buf = buf.subarray(nl + 2);
      if (line === '') { this.done = true; break; }
    }
    this._pending = buf;
    return out;
  }
  // Peer closed. Returns an Error when the close truncated the message.
  eof() {
    if (this.mode === 'eof') { this.done = true; return null; }
    if (this.done) return null;
    return Object.assign(new Error('node-shim: connection closed before the message body completed'),
      { code: 'ECONNRESET' });
  }
  // Bytes past the end of this message (chunked only leaves any when the peer
  // pipelines; we never reuse a connection, so this is only ever the upgrade
  // hand-off path).
  leftover() { return this.mode === 'chunked' ? this._pending : new Uint8Array(0); }
}

function indexOfCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/* ---- server ---------------------------------------------------------------- */

// Node uses ONE IncomingMessage for both faces: server-side it carries
// method/url, client-side statusCode/statusMessage. It is a Readable in node,
// and it is a Readable here — which is what makes the client's response body
// consumable the way every caller expects (res.on('data'), for await, .pipe(),
// stream/consumers), and simultaneously fixes a latent server-side hazard: the
// old hand-rolled `emit('data')` dropped bytes for a handler that attached its
// listener a tick late (the same class of bug as bug #1 in
// libexec/node-shim/modules/stream.cjs's header). Readable buffers instead.
class IncomingMessage extends Readable {
  constructor(fields = {}) {
    super({});
    this.httpVersion = fields.httpVersion || '1.1';
    this.headers = fields.headers || Object.create(null);
    this.rawHeaders = fields.rawHeaders || [];
    this.complete = false;
    this.aborted = false;
    this.socket = fields.socket || null;
    this.connection = this.socket;
    // Server face
    this.method = fields.method;
    this.url = fields.url;
    // Client face
    this.statusCode = fields.statusCode;
    this.statusMessage = fields.statusMessage;
  }
  setTimeout(ms, cb) { if (this.socket && this.socket.setTimeout) this.socket.setTimeout(ms, cb); return this; }
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
// Head + body parsing go through the SHARED parser above — the same code the
// client uses — so chunked request bodies now work here too (they used to be a
// loud wall; the client needed a chunked decoder anyway and a second copy of
// one is how the two faces would have drifted).
async function serveConnection(server, sock) {
  const enc = new TextEncoder();
  try {
    const { readable, writable } = await sock.opened;
    const reader = readable.getReader();
    let head = new Uint8Array(0);
    // Reads until the head block is complete; `head` then holds head + any body
    // bytes that arrived with it.
    for (;;) {
      if (headEndIndex(head) !== -1) break;
      const { value, done } = await reader.read();
      if (done || !value) { sock.close(); return; }
      head = concatBytes(head, value);
    }
    const he = headEndIndex(head);
    const { startLine, headerLines } = splitHead(latin1(head.subarray(0, he)));
    const [method, url, proto] = startLine.split(' ');
    const { headers, rawHeaders } = parseHeaderLines(headerLines);

    const req = new IncomingMessage({
      method, url, headers, rawHeaders,
      httpVersion: (proto || 'HTTP/1.1').replace(/^HTTP\//, ''),
    });
    const res = new ServerResponse(async (h, respBody) => {
      const writer = writable.getWriter();
      await writer.write(concatBytes(enc.encode(h), respBody));
      writer.releaseLock();
      sock.close();
    });
    server.emit('request', req, res);

    // Body pumped on a later tick, after the handler has attached its listeners
    // (node also delivers asynchronously). Readable buffers regardless.
    const framing = bodyFraming(headers, { isResponse: false });
    const dec = new BodyDecoder(framing.mode, framing.length);
    setTimeout(async () => {
      try {
        for (const c of dec.push(head.subarray(he + 4))) req.push(Buffer.from(c));
        while (!dec.done) {
          const { value, done } = await reader.read();
          if (done || !value) {
            const e = dec.eof();
            if (e) { req.emit('error', e); return; }
            break;
          }
          for (const c of dec.push(value)) req.push(Buffer.from(c));
        }
        req.complete = true;
        req.push(null);
      } catch (e) { req.emit('error', e); }
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


/* ---- client ----------------------------------------------------------------
 * A real HTTP/1.1 client over tjs.connect('tcp'|'tls', ...) — NOT a wrapper
 * around fetch. fetch cannot express what the reachable callers need: an
 * `upgrade`/`connect` hand-off of the raw socket, a ClientRequest that IS a
 * writable stream, per-socket timeouts, or a response delivered as a node
 * Readable. (A fetch-backed stand-in was written once before and reverted for
 * exactly that reason — BACKLOG.md, "`http.request`/`https.request` are a WALL
 * in the node-shim (2026-07-31)"; this is the "implement it properly" branch of
 * that entry.)
 *
 * WHAT IS COVERED (all characterized differentially against host node in
 * test/node-shim-http-client.test.cjs, both sides talking to the SAME real node
 * http server):
 *   - request(url|options[, options][, cb]) and get(...) for http and https
 *   - ClientRequest as a writable stream: write/end/pipe-target, setHeader/
 *     getHeader/removeHeader/hasHeader/getHeaders/getHeaderNames, flushHeaders,
 *     destroy/abort, setTimeout, setNoDelay, setSocketKeepAlive
 *   - request bodies: a known-length body via end(body), a streamed body via
 *     write()+end() (framed with Transfer-Encoding: chunked, like node), and a
 *     caller-supplied Content-Length
 *   - response bodies: Content-Length, chunked (incl. chunk extensions and
 *     trailers), and read-until-EOF; HEAD/204/304 correctly carry none
 *   - 1xx: 'continue' (so Expect: 100-continue works) and 'information'
 *   - 'upgrade' (101) and 'connect' (CONNECT) with the raw socket + head bytes
 *   - events: 'socket', 'response', 'error', 'timeout', 'close', 'finish'
 *   - TLS: verifyPeer (rejectUnauthorized), SNI (servername), a caller CA, and
 *     client certs; with no CA given, the engine's own embedded Mozilla bundle
 *     is used — the same bytes tls.rootCertificates exposes
 *
 * WHAT IS DELIBERATELY NOT COVERED — every one of these THROWS a named,
 * greppable error rather than quietly doing something approximate. A
 * half-present client is worse than an absent one: the bundle's loud "not a
 * function" would become a silent wrong answer, which is the failure mode this
 * codebase has been bitten by repeatedly (MessageEvent handing back the init
 * dict; CustomEvent.detail coerced to a boolean; a throwing module left in the
 * require cache and reported as loaded).
 *   - `socketPath` / `createConnection` / `lookup` / `localAddress` / `family`:
 *     ERR_SHIM_HTTP_UNSUPPORTED_OPTION. These decide WHERE or HOW the
 *     connection is made; ignoring one sends bytes somewhere the caller did not
 *     ask for. (npm `ws` always sets createConnection — see the note in
 *     libexec/bun-shim.cjs — so ws still does not connect through this client,
 *     by design, and says so by name.)
 *   - TLS options that change trust or the handshake and have no tjs.connect
 *     equivalent (pfx, passphrase, secureContext, ciphers, minVersion,
 *     maxVersion, checkServerIdentity, secureProtocol):
 *     ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION.
 *   - a Transfer-Encoding other than `chunked`: ERR_SHIM_HTTP_UNSUPPORTED_TE.
 *   - an https ORIGIN through a proxy: ERR_SHIM_HTTPS_PROXY_UNSUPPORTED. The
 *     CONNECT tunnel is easy; starting TLS on the socket it returns is what
 *     this engine cannot do. We refuse instead of connecting directly, because
 *     a direct connection is exactly the silent proxy bypass (see "proxy").
 *   - a proxy agent this client cannot read, or one naming a non-http(s) proxy
 *     (socks): ERR_SHIM_HTTP_UNSUPPORTED_AGENT_PROXY — again a refusal rather
 *     than a connection the caller did not ask for.
 *   - http2 / h2c: absent here, as it always was.
 *
 * KNOWN, DOCUMENTED DIVERGENCES (behaviour differs from node but nothing is
 * silently wrong):
 *   - NO CONNECTION POOLING. Every request opens its own socket and sends
 *     `Connection: close` (unless the caller set a Connection header, e.g. an
 *     upgrade). An Agent's keepAlive/maxSockets are read only as connect-time
 *     hints (TCP keep-alive delay); `socket.setKeepAlive()` after connect is a
 *     no-op, because tjs sets that at connect time only. This is a throughput
 *     difference, not a semantic one — and it is why `req.reusedSocket` is
 *     always false.
 *   - `socket.cork()/uncork()` are no-ops (writes are already issued in order;
 *     cork only batches).
 *   - `socket.end()` closes the connection rather than half-closing it (tjs has
 *     no shutdown(SHUT_WR)).
 *   - the socket surface is the slice node's HTTP client hands out, not all of
 *     net.Socket. net.connect/net.Server remain the wall they always were.
 */

const NO_DEFAULT_BODY = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

function shimError(message, code) {
  return Object.assign(new Error(message), { code });
}

// tjs's connect errors already carry a POSIX-ish `code`; the one that differs
// from node's spelling is DNS failure (EAI_NONAME vs node's ENOTFOUND).
function mapConnectError(e, host, port) {
  const code = e && e.code === 'EAI_NONAME' ? 'ENOTFOUND' : (e && e.code);
  const err = new Error(`${code || 'ECONNFAILED'}: ${(e && e.message) || e} (${host}:${port})`);
  err.code = code || 'ECONNFAILED';
  err.errno = e && e.errno;
  err.syscall = 'connect';
  err.address = host;
  err.port = port;
  return err;
}

/* ---- proxy (HTTP(S)_PROXY / NO_PROXY) --------------------------------------
 * WHAT WAS SILENT. quaude's ENGINE already honours the proxy environment for
 * everything it carries itself — `fetch`, the global `XMLHttpRequest`, and
 * WebSocket all go through the proxy (txiki's lws client vhost, src/lws-utils.c
 * `tjs__parse_proxy_url`/`no_proxy` matching), which is where essentially all of
 * the bundle's traffic goes. This client was the one transport in the process
 * that did not: with HTTP(S)_PROXY set it connected STRAIGHT to the origin and
 * said nothing. Two ways to get bitten by that, and the second is the bad one:
 * behind a MANDATORY proxy the connection just fails oddly, but behind a
 * MONITORING or FILTERING proxy the traffic leaves by a route the environment
 * believes is closed — and "it worked" and "it went around your proxy" look
 * identical from outside.
 *
 * It was also a naude-vs-quaude divergence, not merely a gap: clode's launcher
 * sets NODE_USE_ENV_PROXY=1 for every target it builds (libexec/target-env.cjs
 * — quaude gets it too), and node >= 24 honours the proxy environment in
 * http/https clients under that flag. MEASURED on the host oracle (node
 * v24.18.1), not assumed:
 *   - NODE_USE_ENV_PROXY=1 + HTTP_PROXY -> `GET http://host:port/path HTTP/1.1`
 *     to the proxy, `Host:` still the origin, plus `proxy-connection:` mirroring
 *     Connection and `proxy-authorization: Basic <b64>` when the proxy URL
 *     carries credentials (the port is omitted from the absolute URI when it is
 *     the scheme default, and an IPv6 literal is bracketed — exactly the Host
 *     header's own spelling).
 *   - https origin -> `CONNECT host:443 HTTP/1.1` tunnel.
 *   - the flag is a boolean env option: ONLY the exact string "1" enables it
 *     ("true"/"yes"/"2"/""/unset all went direct).
 *   - the env applies to the GLOBAL agent: `agent: new http.Agent()` and
 *     `agent: false` go DIRECT, `agent: http.globalAgent` (or an agent built
 *     with `{ proxyEnv: process.env }`) proxies.
 *   - a non-http(s) proxy URL (socks5://...) is IGNORED — node goes direct.
 * Everything below is a port of node's own semantics (lib/internal/http.js,
 * `ProxyConfig`/`shouldUseProxy`, read out of the host node via
 * `--expose-internals`), so the two agree case for case; the shared no_proxy
 * matcher is unit-tested against node's real implementation in
 * test/node-shim-http-proxy.test.cjs.
 *
 * An https:// PROXY URL (TLS to the proxy itself) IS supported for an http
 * origin — but its certificate can only be trusted through a caller-supplied
 * `ca`: measured, neither SSL_CERT_FILE nor TJS_CA_BUNDLE reaches
 * tjs.connect('tls', ...), so there is no environment knob for a private CA on
 * a client socket here (node has NODE_EXTRA_CA_CERTS). Untrusted means a
 * VISIBLE failure — never a direct connection.
 *
 * WHAT IS NOT COVERED, loudly: an HTTPS origin through a proxy needs TLS
 * started over the socket the CONNECT tunnel returns, and this engine cannot do
 * that — tjs.connect('tls', host, port) always makes its OWN connection, and
 * there is no adopt-this-fd/startTls entry point (src/js/core/sockets.js). So a
 * proxied https request THROWS ERR_SHIM_HTTPS_PROXY_UNSUPPORTED instead of
 * connecting directly. Refusing is the point: a direct connection is precisely
 * the silent bypass this section exists to end.
 */

// Node reads NODE_USE_ENV_PROXY once at startup, as a boolean CLI option; its
// boolean env parser accepts the exact string "1" and nothing else (measured).
// We read it per request instead of once at construction — a documented
// divergence, and the direction that costs nothing: it cannot turn a proxied
// request into a direct one behind the caller's back.
function envProxyEnabled(env) { return env && env.NODE_USE_ENV_PROXY === '1'; }

function currentEnv() {
  const p = globalThis.process;
  return (p && p.env) || {};
}

// Lower case wins over upper case, per the de-facto convention node follows.
//
// ALL_PROXY is a DELIBERATE ADDITION to node's list (node reads only the
// http_proxy/https_proxy pairs), and the one place this section knowingly
// diverges. The reason is the process it lives in: this engine's own fetch/XHR
// DO honour all_proxy (src/lws-utils.c), so a user who sets only ALL_PROXY gets
// every other transport proxied — and, without this fallback, exactly this
// client going direct. That is the silent bypass again, arrived at through the
// env list. Erring towards "use the proxy the user configured" cannot send
// bytes anywhere they did not name.
function proxyUrlFromEnv(env, protocol) {
  const raw = (protocol === 'https:'
    ? (env.https_proxy || env.HTTPS_PROXY)
    : (env.http_proxy || env.HTTP_PROXY)) || env.all_proxy || env.ALL_PROXY;
  if (!raw) return null;
  if (raw.includes('\r') || raw.includes('\n')) {
    throw shimError(`Invalid proxy URL: ${raw}`, 'ERR_PROXY_INVALID_CONFIG');
  }
  return raw;
}

function isIPv4(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function ipToInt(s) {
  const p = String(s).split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

// node's ProxyConfig, minus the socket-pooling bits we have no use for.
function makeProxyConfig(rawUrl, noProxyList) {
  let u;
  try { u = new URL(rawUrl); } catch {
    throw shimError(`Invalid proxy URL: ${rawUrl}`, 'ERR_PROXY_INVALID_CONFIG');
  }
  const cfg = {
    href: rawUrl,
    protocol: u.protocol,
    host: u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    auth: undefined,
    bypassList: noProxyList ? String(noProxyList).split(',').map((e) => e.trim().toLowerCase()) : [],
  };
  if (u.username || u.password) {
    const auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    cfg.auth = `Basic ${Buffer.from(auth).toString('base64')}`;
    u.username = ''; u.password = '';
    cfg.href = u.href;                 // never log or re-send the credentials
  }
  return cfg;
}

// node's ProxyConfig#shouldUseProxy, ported behaviour-for-behaviour: exact host
// and host:port, `*`, curl-style leading-dot suffixes, `*.suffix` wildcards, and
// simple IPv4 ranges (`10.0.0.1-10.0.0.9`). CIDR is not supported THERE either.
function shouldUseProxy(cfg, hostname, port) {
  const bypassList = (cfg && cfg.bypassList) || [];
  if (!bypassList.length) return true;
  const host = String(hostname).toLowerCase();
  const hostWithPort = port ? `${host}:${port}` : host;
  for (const entry of bypassList) {
    if (entry === '*') return false;
    if (entry === host || entry === hostWithPort) return false;
    if (entry[0] === '.') {
      const suffix = entry.substring(1);
      if (host === suffix
          || (host.endsWith(suffix) && host[host.length - suffix.length - 1] === '.')) return false;
    }
    if (entry.startsWith('*.') && host.endsWith(entry.substring(1))) return false;
    if (entry.includes('-') && isIPv4(host)) {
      const [rawStart, rawEnd] = entry.split('-');
      const startIP = (rawStart || '').trim();
      const endIP = (rawEnd || '').trim();
      if (startIP && endIP && isIPv4(startIP) && isIPv4(endIP)) {
        const h = ipToInt(host);
        if (h >= ipToInt(startIP) && h <= ipToInt(endIP)) return false;
      }
    }
  }
  return true;
}

// Say a thing once per process, on stderr. Used only where we are about to do
// something a proxy-configured user would want to know about.
const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  const p = globalThis.process;
  if (p && p.stderr && typeof p.stderr.write === 'function') p.stderr.write(`${message}\n`);
}

// An explicit proxy AGENT (http-proxy-agent/https-proxy-agent keep the proxy URL
// on `agent.proxy`) is the caller SAYING "send this through here". This client
// does not run agents at all, so before this it was ignored — the same silent
// bypass, arrived at from the other direction. It is reachable: with a proxy
// configured, the bundle builds an HttpsProxyAgent for the Bedrock backend and
// hands it to @smithy/node-http-handler.
function proxyFromAgent(agent) {
  // A FALSY `proxy` is the "no proxy" idiom (axios spells it `proxy: false`),
  // not an unreadable one — refusing there would break a caller who explicitly
  // asked for no proxy at all.
  if (!agent || typeof agent !== 'object' || !agent.proxy) return null;
  const p = agent.proxy;
  const href = typeof p === 'string' ? p : (typeof p.href === 'string' ? p.href : null);
  if (!href) {
    throw shimError(
      'node-shim: this request carries a proxy agent whose proxy this client cannot read '
      + `(${(agent.constructor && agent.constructor.name) || 'agent'}.proxy is not a URL). Refusing to `
      + 'connect directly, because that would silently bypass the proxy the caller asked for.',
      'ERR_SHIM_HTTP_UNSUPPORTED_AGENT_PROXY');
  }
  const proto = href.slice(0, href.indexOf(':') + 1);
  if (proto !== 'http:' && proto !== 'https:') {
    throw shimError(
      `node-shim: proxy agent names a '${proto}' proxy; this client can only speak to http:// and `
      + 'https:// proxies. Refusing to connect directly, because that would silently bypass it.',
      'ERR_SHIM_HTTP_UNSUPPORTED_AGENT_PROXY');
  }
  return href;
}

// The proxy (if any) this request must go through. Explicit agent first — that
// is the caller's own instruction — then the environment, on node's terms.
function resolveProxy(opts, protocol, host, port) {
  const env = currentEnv();
  const fromAgent = proxyFromAgent(opts.agent);
  if (fromAgent) {
    const cfg = makeProxyConfig(fromAgent, env.no_proxy || env.NO_PROXY);
    return shouldUseProxy(cfg, host, port) ? cfg : null;
  }
  const agent = opts.agent;
  // node: the env applies to the global agent, or to one built with proxyEnv.
  const agentEnv = (agent && typeof agent === 'object' && agent.options && agent.options.proxyEnv) || null;
  const isGlobal = agent == null || (typeof agent === 'object' && agent._shimGlobalAgent === true);
  if (!agentEnv && !isGlobal) return null;
  const useEnv = agentEnv || env;
  if (!agentEnv && !envProxyEnabled(env)) return null;
  const raw = proxyUrlFromEnv(useEnv, protocol);
  if (!raw) return null;
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    // node ignores these and goes direct. We do the same — matching node's
    // routing matters more than our opinion — but we do not do it quietly.
    warnOnce(`unsupported-proxy:${raw}`,
      `node-shim: the configured proxy ${raw} is not an http:// or https:// proxy, so it is `
      + 'IGNORED (node does the same) — this request is going DIRECT, not through your proxy.');
    return null;
  }
  const cfg = makeProxyConfig(raw, useEnv.no_proxy || useEnv.NO_PROXY);
  return shouldUseProxy(cfg, host, port) ? cfg : null;
}

function toBytes(chunk, enc) {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === 'string') { const b = Buffer.from(chunk, enc || 'utf8'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const b = Buffer.from(String(chunk));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

// The slice of net.Socket that node's HTTP client actually hands to callers:
// the `req.socket` smithy pokes at (connecting/setKeepAlive/setTimeout), and
// the raw duplex an 'upgrade'/'connect' listener takes over. NOT a general
// net.Socket — net.connect is still the wall it always was, on purpose.
class ClientSocket extends EventEmitter {
  constructor() {
    super();
    this.connecting = true;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.timeout = 0;
    this._sock = null;
    this._writer = null;
    this._writeChain = Promise.resolve();
    this._paused = false;
    this._buf = [];
    this._ended = false;
    this._timer = null;
  }

  async _open(transport, host, port, opts) {
    const sock = await tjs.connect(transport, host, port, opts);
    const info = await sock.opened;
    this._sock = sock;
    this._writer = info.writable.getWriter();
    this.connecting = false;
    this.remoteAddress = info.remoteAddress;
    this.remotePort = info.remotePort;
    this.localAddress = info.localAddress;
    this.localPort = info.localPort;
    this.emit('connect');
    this._pump(info.readable.getReader());
    return this;
  }

  async _pump(reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        this.bytesRead += value.length;
        this._touch();
        this._deliver(value);
      }
    } catch (e) {
      if (!this.destroyed) this.emit('error', shimError(`node-shim: socket read failed: ${(e && e.message) || e}`, (e && e.code) || 'ECONNRESET'));
      return;
    }
    this._ended = true;
    this.readable = false;
    this._flush();                 // deliver anything buffered before 'end'
    if (!this._buf.length) this._finishRead();
  }

  _finishRead() {
    if (this._endEmitted) return;
    this._endEmitted = true;
    this.emit('end');
    this._clearTimer();
    if (!this.destroyed) { this.destroyed = true; this.emit('close', false); }
  }

  // Hold bytes when nobody is listening or the socket is paused, so the
  // 'upgrade' hand-off (request stops reading, the new owner attaches on a
  // later tick) cannot lose the first frame.
  _deliver(bytes) {
    this._buf.push(Buffer.from(bytes));
    this._flush();
  }
  _flush() {
    if (this._paused) return;
    while (this._buf.length && this.listenerCount('data') > 0 && !this._paused) {
      this.emit('data', this._buf.shift());
    }
    if (this._ended && !this._buf.length) this._finishRead();
  }
  on(name, fn) { super.on(name, fn); if (name === 'data') this._flush(); return this; }
  once(name, fn) { super.once(name, fn); if (name === 'data') this._flush(); return this; }

  pause() { this._paused = true; return this; }
  resume() { this._paused = false; this._flush(); return this; }
  isPaused() { return this._paused; }
  unshift(chunk) { if (chunk && chunk.length) this._buf.unshift(Buffer.from(chunk)); return this; }

  write(chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    const bytes = toBytes(chunk, enc);
    this.bytesWritten += bytes.length;
    this._touch();
    this._writeChain = this._writeChain.then(async () => {
      if (this.destroyed) return;
      if (!this._writer) throw shimError('node-shim: socket write before connect', 'ERR_SOCKET_CLOSED');
      await this._writer.write(bytes);
    }).then(() => { if (cb) cb(); }, (e) => {
      const err = shimError(`node-shim: socket write failed: ${(e && e.message) || e}`, (e && e.code) || 'EPIPE');
      if (cb) cb(err); else this.emit('error', err);
    });
    return true;
  }
  // DIVERGENCE: a full close, not a half-close — tjs exposes no shutdown(SHUT_WR).
  end(chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (chunk != null) this.write(chunk, enc);
    this.writable = false;
    this._writeChain = this._writeChain.then(() => { this.destroy(); if (cb) cb(); });
    return this;
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = this.writable = false;
    this._clearTimer();
    try { if (this._sock) this._sock.close(); } catch { /* already gone */ }
    queueMicrotask(() => { if (err) this.emit('error', err); this.emit('close', !!err); });
    return this;
  }

  // Inactivity timer. Node emits 'timeout' and does NOT destroy the socket.
  setTimeout(ms, cb) {
    this.timeout = ms || 0;
    if (cb) this.once('timeout', cb);
    this._clearTimer();
    if (ms > 0) this._arm();
    return this;
  }
  _arm() { this._timer = setTimeout(() => { this._timer = null; this.emit('timeout'); }, this.timeout); }
  _touch() { if (this.timeout > 0) { this._clearTimer(); this._arm(); } }
  _clearTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  // Connect-time knobs in tjs; see the divergence list in this section's header.
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  cork() { return this; }
  uncork() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: this.localAddress, family: String(this.localAddress || '').includes(':') ? 'IPv6' : 'IPv4', port: this.localPort }; }
}

const UNSUPPORTED_REQUEST_OPTIONS = ['socketPath', 'createConnection', 'lookup', 'localAddress', 'family'];
const UNSUPPORTED_TLS_OPTIONS = ['pfx', 'passphrase', 'secureContext', 'ciphers', 'minVersion', 'maxVersion', 'checkServerIdentity', 'secureProtocol'];

// request(url[, options][, cb]) | request(options[, cb]) — node's signatures.
function normalizeArgs(url, options, cb, defaults) {
  if (typeof url === 'string' || (url && typeof url === 'object' && typeof url.href === 'string' && typeof url.protocol === 'string')) {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (typeof options === 'function') { cb = options; options = {}; }
    options = { ...fromURL(u), ...(options || {}) };
  } else {
    if (typeof options === 'function') { cb = options; options = undefined; }
    options = { ...(url || {}) };
  }
  if (typeof cb !== 'function') cb = undefined;
  return [{ ...defaults, ...options }, cb];
}
function fromURL(u) {
  const o = {
    protocol: u.protocol,
    hostname: u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname,
    port: u.port || undefined,
    path: `${u.pathname || '/'}${u.search || ''}`,
  };
  if (u.username || u.password) o.auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return o;
}

class ClientRequest extends EventEmitter {
  constructor(options, cb) {
    super();
    for (const k of UNSUPPORTED_REQUEST_OPTIONS) {
      if (options[k] !== undefined && options[k] !== null) {
        throw shimError(
          `node-shim: http.request option '${k}' is not supported (this client always connects with tjs.connect; `
          + 'net.connect/createConnection remain unimplemented)',
          'ERR_SHIM_HTTP_UNSUPPORTED_OPTION');
      }
    }
    const agentOpts = (options.agent && typeof options.agent === 'object' && options.agent.options) || {};
    for (const k of UNSUPPORTED_TLS_OPTIONS) {
      if (options[k] !== undefined || agentOpts[k] !== undefined) {
        throw shimError(
          `node-shim: TLS option '${k}' is not supported by this client (tjs.connect exposes only ca/cert/key/sni/alpn/verifyPeer)`,
          'ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION');
      }
    }

    this._opts = options;
    this.protocol = options.protocol || 'http:';
    this._tls = this.protocol === 'https:';
    const rawHost = options.hostname || options.host || 'localhost';
    // `host` may carry a port ("example.com:8080"); node's hostname wins.
    this.host = String(rawHost).replace(/:\d+$/, '');
    if (this.host.startsWith('[') && this.host.endsWith(']')) this.host = this.host.slice(1, -1);
    this.port = Number(options.port || options.defaultPort || (this._tls ? 443 : 80));
    this.method = String(options.method || 'GET').toUpperCase();
    this.path = options.path || '/';
    this.finished = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.aborted = false;
    this.headersSent = false;
    this.reusedSocket = false;
    this.socket = null;
    this.connection = null;

    this._headers = new Map();          // lower-case key -> [origName, value]
    for (const [k, v] of Object.entries(options.headers || {})) {
      if (v !== undefined) this._headers.set(String(k).toLowerCase(), [String(k), v]);
    }
    if (options.auth && !this._headers.has('authorization')) {
      this._headers.set('authorization', ['Authorization', `Basic ${Buffer.from(String(options.auth)).toString('base64')}`]);
    }
    // The origin's authority, spelled the way node spells it in BOTH the Host
    // header and the absolute-form request target it sends to a proxy: the port
    // is dropped when it is the scheme default, an IPv6 literal is bracketed.
    const dfltPort = this._tls ? 443 : 80;
    const hostHdr = this.host.includes(':') ? `[${this.host}]` : this.host;
    this._authority = this.port === dfltPort ? hostHdr : `${hostHdr}:${this.port}`;
    if (options.setHost !== false && !this._headers.has('host')) {
      this._headers.set('host', ['Host', this._authority]);
    }

    // Proxy decision BEFORE the socket exists: it changes where we connect and
    // what the request line says. A proxied https origin cannot be tunnelled by
    // this engine, and we refuse rather than leak a direct connection past it.
    this._proxy = resolveProxy(options, this.protocol, this.host, this.port);
    if (this._proxy && this._tls) {
      throw shimError(
        `node-shim: https://${this._authority} is configured to go through the proxy ${this._proxy.href}, `
        + 'but this client cannot tunnel TLS through a proxy: a CONNECT tunnel needs TLS started over an '
        + "existing socket, and this engine's tjs.connect('tls', ...) always makes its own connection. "
        + 'REFUSING to connect directly, because that would silently bypass your proxy. Use NO_PROXY for '
        + 'this host if a direct connection is what you want.',
        'ERR_SHIM_HTTPS_PROXY_UNSUPPORTED');
    }
    // (A synchronous throw, like this file's other refusals — and the shape the
    // reachable caller wants: smithy builds its request inside a promise
    // executor, so this surfaces as a rejection, not an uncaught crash.)
    // Credentials from the proxy URL, as node sends them (it sets this after
    // the caller's headers, so the connection-level credential wins).
    if (this._proxy && this._proxy.auth) {
      this._headers.set('proxy-authorization', ['proxy-authorization', this._proxy.auth]);
    }
    // DIVERGENCE (documented above): no pooling, so always close.
    if (!this._headers.has('connection')) this._headers.set('connection', ['Connection', 'close']);
    // node mirrors Connection into proxy-connection on a proxied request (it
    // sends `proxy-connection: keep-alive` from a pooling agent and
    // `proxy-connection: close` from a non-pooling one; we are always the
    // latter). Lower-case name, as node spells it.
    if (this._proxy && !this._headers.has('proxy-connection')) {
      this._headers.set('proxy-connection', ['proxy-connection', this.getHeader('connection')]);
    }

    this._queue = [];                   // bytes waiting for the socket
    this._headSent = false;
    this._chunkedBody = false;
    this._resStarted = false;
    this._closed = false;

    if (cb) this.once('response', cb);
    this._connect();
    if (options.timeout !== undefined) this.setTimeout(options.timeout);
    // Expect: 100-continue means the caller will WAIT for the interim response
    // before writing a body — so the head has to go out now, exactly as node
    // does. Without this the head would sit unsent until end(), and a client
    // that (correctly) waits for 'continue' would deadlock.
    if (/100-continue/i.test(String(this.getHeader('expect') || ''))) this._sendHead(null);
  }

  /* -- outgoing headers (node's OutgoingMessage surface) -- */
  setHeader(name, value) {
    if (this._headSent) throw shimError('Cannot set headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
    this._headers.set(String(name).toLowerCase(), [String(name), value]);
    return this;
  }
  getHeader(name) { const e = this._headers.get(String(name).toLowerCase()); return e && e[1]; }
  hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
  getHeaders() { const o = Object.create(null); for (const [k, [, v]] of this._headers) o[k] = v; return o; }
  getHeaderNames() { return [...this._headers.keys()]; }
  flushHeaders() { if (!this._headSent) this._sendHead(null); return this; }

  /* -- connection -- */
  _connect() {
    const sock = new ClientSocket();
    (async () => {
      try {
        // queueMicrotask so a listener attached right after request() still
        // sees 'socket' — node assigns the socket asynchronously too.
        await Promise.resolve();
        if (this.destroyed) { sock.destroy(); return; }
        this.socket = this.connection = sock;
        sock.on('timeout', () => this.emit('timeout'));
        sock.on('error', (e) => this._fail(e));
        this.emit('socket', sock);
        // With a proxy, the socket goes to the PROXY (TLS when the proxy URL is
        // https://); the origin is named in the request line instead. A proxied
        // https ORIGIN never gets here — the constructor already refused it.
        const target = this._proxy
          ? { transport: this._proxy.protocol === 'https:' ? 'tls' : 'tcp', host: this._proxy.host, port: this._proxy.port }
          : { transport: this._tls ? 'tls' : 'tcp', host: this.host, port: this.port };
        await sock._open(target.transport, target.host, target.port, this._connectOptions());
        if (this.destroyed) { sock.destroy(); return; }
        this._readResponse(sock);
        this._drain();
      } catch (e) {
        // Name the PROXY when the proxy is what failed: a dead proxy must not
        // read as a dead origin (and must not fall back to a direct connection
        // — there is no such fallback here, on purpose).
        const err = this._proxy
          ? mapConnectError(e, this._proxy.host, this._proxy.port)
          : mapConnectError(e, this.host, this.port);
        if (this._proxy) {
          err.message += ` — connecting to the proxy ${this._proxy.href} for ${this.protocol}//${this._authority}`;
          err.proxy = this._proxy.href;
        }
        this._fail(err);
      }
    })();
  }
  _connectOptions() {
    const o = { noDelay: true };
    const agent = this._opts.agent;
    const ag = (agent && typeof agent === 'object' && agent.options) || {};
    const keepAlive = (agent && typeof agent === 'object' && agent.keepAlive) || ag.keepAlive;
    if (keepAlive) o.keepAliveDelay = Math.max(1, Math.round(((agent && agent.keepAliveMsecs) || ag.keepAliveMsecs || 1000) / 1000));
    // The TLS leg is the ORIGIN's when we connect to it directly, and the
    // PROXY's when the proxy URL is https:// (an http origin behind a TLS
    // proxy still needs a certificate checked — the caller's `ca` is the only
    // way to trust a private one here; see the proxy section's CA note).
    if (!this._tls && !(this._proxy && this._proxy.protocol === 'https:')) return o;
    const pick = (k) => (this._opts[k] !== undefined ? this._opts[k] : ag[k]);
    const ca = pick('ca');
    if (ca !== undefined) o.ca = Array.isArray(ca) ? ca.map(String).join('\n') : String(ca);
    const cert = pick('cert'); if (cert !== undefined) o.cert = String(cert);
    const key = pick('key'); if (key !== undefined) o.key = String(key);
    const servername = pick('servername'); if (servername) o.sni = String(servername);
    const alpn = pick('ALPNProtocols'); if (alpn) o.alpn = [].concat(alpn).map(String);
    const ru = pick('rejectUnauthorized');
    if (ru !== undefined) o.verifyPeer = !!ru;
    return o;
  }

  /* -- outgoing body -- */
  _push(bytes) { this._queue.push(bytes); this._drain(); }
  _drain() {
    if (!this.socket || this.socket.connecting || this.socket.destroyed) return;
    while (this._queue.length) this.socket.write(this._queue.shift());
  }
  _sendHead(contentLength) {
    if (this._headSent) return;
    if (contentLength === null) {
      // Streaming (flushHeaders, or write() before end()): frame with chunked
      // unless the caller already declared the framing, exactly like node.
      if (!this._headers.has('content-length') && !this._headers.has('transfer-encoding')
          && !NO_DEFAULT_BODY.has(this.method)) {
        this._headers.set('transfer-encoding', ['Transfer-Encoding', 'chunked']);
      }
    } else if (!this._headers.has('content-length') && !this._headers.has('transfer-encoding')) {
      // Known-length body. Node omits Content-Length entirely for an empty body
      // on a method that does not normally carry one.
      if (contentLength > 0 || !NO_DEFAULT_BODY.has(this.method)) {
        this._headers.set('content-length', ['Content-Length', String(contentLength)]);
      }
    }
    this._chunkedBody = /chunked/i.test(String(this.getHeader('transfer-encoding') || ''));
    // Through a proxy the request target is absolute-form (origin-form only
    // says "/path", which a proxy cannot route). Byte-identical to node's.
    const target = this._proxy ? `${this.protocol}//${this._authority}${this.path}` : this.path;
    let head = `${this.method} ${target} HTTP/1.1\r\n`;
    for (const [, [name, value]] of this._headers) {
      for (const v of Array.isArray(value) ? value : [value]) head += `${name}: ${v}\r\n`;
    }
    head += '\r\n';
    this._headSent = true;
    this.headersSent = true;
    this._push(toBytes(head, 'latin1'));
  }
  write(chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (this.finished) {
      const err = shimError('write after end', 'ERR_STREAM_WRITE_AFTER_END');
      if (cb) queueMicrotask(() => cb(err)); else queueMicrotask(() => this.emit('error', err));
      return false;
    }
    this._sendHead(null);
    const bytes = toBytes(chunk, enc);
    if (bytes.length) this._push(this._chunkedBody ? chunkFrame(bytes) : bytes);
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (this.finished) {
      if (cb) queueMicrotask(() => cb(shimError('end() called after stream was finished', 'ERR_STREAM_ALREADY_FINISHED')));
      return this;
    }
    const bytes = chunk != null ? toBytes(chunk, enc) : null;
    if (!this._headSent) {
      this._sendHead(bytes ? bytes.length : 0);
      if (bytes && bytes.length) this._push(this._chunkedBody ? chunkFrame(bytes) : bytes);
      if (this._chunkedBody) this._push(toBytes('0\r\n\r\n', 'latin1'));
    } else {
      if (bytes && bytes.length) this._push(this._chunkedBody ? chunkFrame(bytes) : bytes);
      if (this._chunkedBody) this._push(toBytes('0\r\n\r\n', 'latin1'));
    }
    this.finished = true;
    this.writableEnded = true;
    queueMicrotask(() => { if (cb) cb(); this.emit('finish'); });
    return this;
  }

  /* -- incoming response -- */
  _readResponse(sock) {
    let buf = new Uint8Array(0);
    let stage = 'head';
    let dec = null;
    let res = null;

    const finishBody = () => {
      if (!res) return;
      res.complete = true;
      res.push(null);
      stage = 'done';
      this._close();
      sock.destroy();
    };

    const onData = (chunk) => {
      try {
        if (stage === 'done') return;
        if (stage === 'body') {
          for (const c of dec.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) res.push(Buffer.from(c));
          if (dec.done) finishBody();
          return;
        }
        buf = concatBytes(buf, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        for (;;) {
          const he = headEndIndex(buf);
          if (he === -1) return;
          const { startLine, headerLines } = splitHead(latin1(buf.subarray(0, he)));
          const m = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})\s*(.*)$/.exec(startLine);
          if (!m) throw shimError(`node-shim: malformed status line '${startLine}'`, 'ERR_SHIM_HTTP_BAD_STATUS_LINE');
          const httpVersion = m[1];
          const statusCode = Number(m[2]);
          const statusMessage = m[3];
          const { headers, rawHeaders } = parseHeaderLines(headerLines);
          const rest = buf.subarray(he + 4);

          // 1xx that is not an upgrade: an interim head, then keep parsing.
          if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
            if (statusCode === 100) this.emit('continue');
            else this.emit('information', { httpVersion, statusCode, statusMessage, headers, rawHeaders });
            buf = rest.slice();
            continue;
          }

          res = new IncomingMessage({ httpVersion, statusCode, statusMessage, headers, rawHeaders, socket: sock });
          const isUpgrade = statusCode === 101;
          const isConnect = this.method === 'CONNECT' && statusCode >= 200 && statusCode < 300;
          if (isUpgrade || isConnect) {
            // Hand the raw socket over. The buffered `rest` becomes the head
            // bytes node passes as the third argument.
            sock.removeListener('data', onData);
            stage = 'done';
            const evt = isUpgrade ? 'upgrade' : 'connect';
            res.complete = true;
            res.push(null);
            if (this.listenerCount(evt) === 0) { sock.destroy(); this._close(); return; }
            this.emit(evt, res, sock, Buffer.from(rest));
            this._close();
            return;
          }

          const framing = bodyFraming(headers, { isResponse: true, statusCode, requestMethod: this.method });
          dec = new BodyDecoder(framing.mode, framing.length);
          stage = 'body';
          this._resStarted = true;
          this.emit('response', res);
          for (const c of dec.push(rest)) res.push(Buffer.from(c));
          if (dec.done) finishBody();
          return;
        }
      } catch (e) { this._fail(e); }
    };

    sock.on('data', onData);
    sock.on('end', () => {
      if (stage === 'done') return;
      if (stage === 'body') {
        const e = dec.eof();
        if (e) { if (res) { res.aborted = true; res.emit('error', e); } else this._fail(e); return; }
        finishBody();
        return;
      }
      this._fail(shimError('socket hang up', 'ECONNRESET'));
    });
  }

  /* -- teardown -- */
  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    if (this.socket) this.socket.destroy();
    queueMicrotask(() => { this.emit('error', err); this.emit('close'); });
  }
  _close() {
    if (this._closed) return;
    this._closed = true;
    queueMicrotask(() => this.emit('close'));
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.aborted = true;
    if (this.socket) this.socket.destroy();
    if (err) this._fail(err); else this._close();
    return this;
  }
  abort() { return this.destroy(); }
  setTimeout(ms, cb) {
    if (cb) this.once('timeout', cb);
    if (this.socket) this.socket.setTimeout(ms);
    else this.once('socket', (s) => s.setTimeout(ms));
    return this;
  }
  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }
}

function chunkFrame(bytes) {
  const head = toBytes(`${bytes.length.toString(16)}\r\n`, 'latin1');
  const tail = toBytes('\r\n', 'latin1');
  return concatBytes(concatBytes(head, bytes), tail);
}

function request(url, options, cb) {
  const [opts, done] = normalizeArgs(url, options, cb, { protocol: 'http:' });
  // node:http refuses an https: URL rather than silently sending plaintext to
  // port 443 (node throws ERR_INVALID_PROTOCOL here too).
  if (opts.protocol && opts.protocol !== 'http:') {
    throw Object.assign(
      new Error(`Protocol "${opts.protocol}" not supported. Expected "http:"`),
      { code: 'ERR_INVALID_PROTOCOL' });
  }
  return new ClientRequest(opts, done);
}
function get(url, options, cb) {
  const req = request(url, options, cb);
  req.end();
  return req;
}

module.exports = {
  Agent, globalAgent, STATUS_CODES, METHODS,
  Server, IncomingMessage, ServerResponse, createServer,
  ClientRequest, request, get,
};
// Internal seam, non-enumerable so it never shows up in Object.keys(http) (node
// has no such property and the surface inventories enumerate): node:https builds
// the SAME ClientRequest with TLS defaults through this, rather than duplicating
// the client.
Object.defineProperty(module.exports, '_internals', {
  value: {
    headEndIndex, parseHeaderLines, splitHead, bodyFraming, BodyDecoder, ClientRequest, normalizeArgs,
    // proxy decision helpers, exposed so they can be tested as pure functions
    // against node's own ProxyConfig (test/node-shim-http-proxy.test.cjs).
    proxy: { envProxyEnabled, proxyUrlFromEnv, makeProxyConfig, shouldUseProxy, resolveProxy },
  },
  enumerable: false,
});
module.exports.default = module.exports;

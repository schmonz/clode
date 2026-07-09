'use strict';
// A local stand-in for the Anthropic Messages API, speaking the streaming SSE
// wire format (event: <type>\ndata: <json>\n\n) that the SDK's stream reader
// consumes. Canned single-turn response whose assistant text is exactly "PONG".
// http by default (simplest; txiki fetch accepts http://127.0.0.1); pass
// {tls:true} for a self-signed https server (the documented fallback if the
// bundle rejects plain http — see the plan's base-URL note).
const http = require('node:http');
const https = require('node:https');

// The canonical Messages streaming SSE sequence (see the claude-api streaming
// doc): message_start -> content_block_start -> [ping] -> content_block_delta*
// -> content_block_stop -> message_delta (stop_reason+usage) -> message_stop.
function cannedSSE(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock_pong', type: 'message', role: 'assistant',
        model: 'claude-opus-4-8', content: [], stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
      },
    }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('ping', { type: 'ping' }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

// A tool_use turn: the assistant requests one tool call (streamed as an empty-
// input content_block_start + one input_json_delta carrying the full input),
// stop_reason 'tool_use'. This is what drives the bundle's agentic loop —
// the next /messages POST from the CLI carries the matching tool_result.
function cannedToolUseSSE(name, input, id = 'toolu_mock_1') {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock_tooluse', type: 'message', role: 'assistant',
        model: 'claude-opus-4-8', content: [], stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
      },
    }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

// Minimal self-signed cert for the https fallback, generated once per process so
// no cert material is committed. Requires `openssl` on PATH; only used when
// opts.tls is set (the wall-walk decides whether it is needed).
function selfSigned() {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-tls-'));
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), certPath: crt };
}

function startMockAnthropic(opts = {}) {
  const text = opts.text || 'PONG';
  const requests = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body });
      // The Messages endpoint: stream the canned SSE. Match on the path suffix so
      // a base URL with or without /v1 still routes. opts.respond(body) lets a
      // test script multi-turn conversations (e.g. tool_use then final text) by
      // keying the reply off the request content; default stays the single
      // canned text turn.
      if (req.method === 'POST' && /\/messages$/.test(req.url.split('?')[0])) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.end(opts.respond ? opts.respond(body) : cannedSSE(text));
        return;
      }
      // Any other request (model list, config probe the wall-walk may reveal):
      // answer benignly so a preflight GET doesn't wall the boot. Recorded above.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  };
  const tls = opts.tls ? selfSigned() : null;
  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, handler)
    : http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
        caCertPath: tls ? tls.certPath : null, // for NODE_EXTRA_CA_CERTS on the https fallback
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockAnthropic, cannedSSE, cannedToolUseSSE };

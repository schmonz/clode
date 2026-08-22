'use strict';
// A hand-rolled HTTP/1.1 origin server for test/node-shim-http-client.test.cjs.
// Deliberately raw (node:net, not node:http) for two reasons:
//   1. it can serve wire shapes node:http will not emit — a body framed only by
//      connection close, chunk extensions, trailers, a bare 100-continue, an
//      early-hints 103, a 101 upgrade — which is most of what an HTTP client
//      has to get right;
//   2. /echo returns the EXACT request line, header list and body it received,
//      so the differential test compares what the shim's client PUT ON THE WIRE
//      against what host node's client put on the wire, not just what each
//      client managed to parse back.
// It always runs under host node (it is the oracle's fixed point); only the
// probe script runs under both engines.
const net = require('node:net');

function parseHead(text) {
  const lines = text.split('\r\n');
  return { startLine: lines[0], headerLines: lines.slice(1).filter(Boolean) };
}
function headerMap(headerLines) {
  const m = Object.create(null);
  for (const l of headerLines) {
    const c = l.indexOf(':');
    const k = l.slice(0, c).trim().toLowerCase();
    const v = l.slice(c + 1).trim();
    m[k] = k in m ? `${m[k]}, ${v}` : v;
  }
  return m;
}
// Minimal chunked decoder for request bodies (the client's chunked WRITER is
// what this validates).
function dechunk(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', i, 'latin1');
    if (nl === -1) return null;
    const size = parseInt(buf.slice(i, nl).toString('latin1').split(';')[0], 16);
    i = nl + 2;
    if (size === 0) return Buffer.concat(out);
    if (buf.length < i + size + 2) return null;
    out.push(buf.slice(i, i + size));
    i += size + 2;
  }
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let head = null;
  let headers = null;
  let sentContinue = false;
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!head) {
      const he = buf.indexOf('\r\n\r\n', 0, 'latin1');
      if (he === -1) return;
      head = parseHead(buf.slice(0, he).toString('latin1'));
      headers = headerMap(head.headerLines);
      buf = buf.slice(he + 4);
      const path = head.startLine.split(' ')[1] || '/';
      if (path.startsWith('/expect') && /100-continue/i.test(headers.expect || '') && !sentContinue) {
        sentContinue = true;
        sock.write('HTTP/1.1 100 Continue\r\n\r\n');
      }
    }
    let body = null;
    if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(buf);
    else {
      const want = Number(headers['content-length'] || 0);
      if (buf.length >= want) body = buf.slice(0, want);
    }
    if (body === null) return;
    respond(sock, head, headers, body);
  });
});

function respond(sock, head, headers, body) {
  const [method, path] = head.startLine.split(' ');
  const route = path.split('?')[0];
  const send = (s) => sock.end(s);

  if (route === '/echo') {
    const payload = JSON.stringify({
      startLine: head.startLine,
      // Header ORDER and CASE as sent, minus Host (it carries the ephemeral
      // port, which differs per run).
      headers: head.headerLines.filter((l) => !/^host:/i.test(l)),
      body: body.toString('utf8'),
    });
    send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    return;
  }
  if (route === '/chunked') {
    send('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n'
      + '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
    return;
  }
  if (route === '/ext') {
    // Chunk extensions plus a trailer — both legal, both must be skipped.
    send('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\n'
      + '3;foo=bar\r\nabc\r\n3;baz\r\ndef\r\n0\r\nX-Sum: 6\r\n\r\n');
    return;
  }
  if (route === '/eof') {
    // No Content-Length, no Transfer-Encoding: the body IS everything up to close.
    send('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nBODY-UNTIL-EOF');
    return;
  }
  if (route === '/204') { send('HTTP/1.1 204 No Content\r\n\r\n'); return; }
  if (route === '/nobody') {
    // Content-Length is advertised but a HEAD response carries no body.
    send(`HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n${method === 'HEAD' ? '' : 'body-here'}`);
    return;
  }
  if (route === '/dup') {
    send('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n'
      + 'Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n'
      + 'X-Multi: one\r\nX-Multi: two\r\n'
      + 'Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nok');
    return;
  }
  if (route === '/info') {
    sock.write('HTTP/1.1 103 Early Hints\r\nLink: </s.css>; rel=preload\r\n\r\n');
    send('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    return;
  }
  if (route === '/expect') {
    const payload = JSON.stringify({ body: body.toString('utf8') });
    send(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    return;
  }
  if (route === '/upgrade') {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: probe\r\nConnection: Upgrade\r\n\r\nHEADBYTES');
    // A later frame proves the socket keeps flowing after the hand-off.
    setTimeout(() => sock.write('AFTER'), 30);
    return;
  }
  if (route === '/slow') { setTimeout(() => send('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nslow'), 3000); return; }
  if (route === '/status') {
    const code = Number(path.split('?')[1] || 418);
    send(`HTTP/1.1 ${code} Teapot Time\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  send('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
}

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});

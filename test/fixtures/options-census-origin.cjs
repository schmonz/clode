'use strict';
// The origin the options census's fetch and http rows talk to (test/options-census.test.cjs), run by HOST node, the
// fixed point: the same server answers native Bun (when the Bun rows are re-recorded), host node and the shim.
// Prints `PORT <n>` once listening. Paths:
//   /slow-headers?ms=N   waits N ms, then answers 200 "ok"
//   /slow-body?ms=N      answers 200 with a first chunk at once, then waits N ms before the rest
//   /gzip                a gzip-encoded "hello gzip" with content-encoding: gzip, whatever was asked
//   /gzip-negotiated     "hello gzip", gzip-encoded only when the request's accept-encoding names gzip
//   /echo                200, JSON of { method, url, headers, body } as received (body gunzipped when the request
//                        says content-encoding: gzip)
//   WebSocket upgrade    any path: the handshake (choosing the first protocol offered), then one text message, the
//                        JSON of { headers, offered } as received, then a close
//   /redirect?n=K        302 to /redirect?n=K-1; n=0 answers 200 "done"
//   /marks               the JSON list of every `mark` query value any request (or upgrade) so far carried: what reached
//                        the origin, for a test that must show a refused request never did
const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');

const marks = [];
const noteMark = (url) => { const m = new URL(url, 'http://x').searchParams.get('mark'); if (m !== null) marks.push(m); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  noteMark(req.url);
  const ms = Number(u.searchParams.get('ms') || 0);
  const parts = [];
  req.on('data', (d) => { parts.push(d); });
  req.on('end', () => {
    let raw = Buffer.concat(parts);
    if (/gzip/i.test(req.headers['content-encoding'] || '')) { try { raw = zlib.gunzipSync(raw); } catch (_) { /* as sent */ } }
    const body = raw.toString('utf8');
    switch (u.pathname) {
      case '/slow-headers': setTimeout(() => { res.writeHead(200); res.end('ok'); }, ms); return;
      case '/slow-body':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first,');
        setTimeout(() => res.end('rest'), ms);
        return;
      case '/gzip': {
        const z = zlib.gzipSync(Buffer.from('hello gzip'));
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': z.length });
        res.end(z);
        return;
      }
      case '/gzip-negotiated': {
        if (/gzip/i.test(req.headers['accept-encoding'] || '')) {
          const z = zlib.gzipSync(Buffer.from('hello gzip'));
          res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': z.length });
          res.end(z);
        } else { res.writeHead(200); res.end('hello gzip'); }
        return;
      }
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
        return;
      case '/marks': res.writeHead(200); res.end(JSON.stringify(marks)); return;
      case '/redirect': {
        const n = Number(u.searchParams.get('n') || 0);
        if (n > 0) { res.writeHead(302, { location: `/redirect?n=${n - 1}` }); res.end(); } else { res.writeHead(200); res.end('done'); }
        return;
      }
      default: res.writeHead(404); res.end();
    }
  });
});
server.on('upgrade', (req, sock) => {
  noteMark(req.url);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
    ...(offered.length ? [`Sec-WebSocket-Protocol: ${offered[0]}`] : []), '', ''].join('\r\n'));
  const msg = Buffer.from(JSON.stringify({ headers: req.headers, offered }));
  const len = msg.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  sock.write(Buffer.concat([head, msg]));
  setTimeout(() => { sock.write(Buffer.from([0x88, 2, 0x03, 0xe8])); sock.end(); }, 200);
  sock.on('error', () => {});
});
server.keepAliveTimeout = 500;
server.listen(0, '127.0.0.1', () => { process.stdout.write(`PORT ${server.address().port}\n`); });

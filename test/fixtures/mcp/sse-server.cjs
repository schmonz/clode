// Minimal MCP-over-SSE server. Logs every request path so a stringified-object
// POST target is visible on the wire, exactly as the backlog entry recorded it.
const http = require('node:http');
const fs = require('node:fs');
const SESSION = 'probe';
const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  process.stderr.write(`<< ${req.method} ${req.url}\n`);
  if (process.env.MCP_MOCK_WIRE) require('node:fs').appendFileSync(process.env.MCP_MOCK_WIRE, `${req.method} ${req.url}\n`);
  if (req.method === 'GET' && url.pathname === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // The endpoint event: data is a RELATIVE URL STRING.
    res.write(`event: endpoint\ndata: /messages?sessionId=${SESSION}\n\n`);
    return; // hold the stream open
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {}; try { msg = JSON.parse(body); } catch { /* */ }
      process.stderr.write(`<< POST BODY method=${msg.method}\n`);
      res.writeHead(202, { 'content-type': 'text/plain' });
      res.end('accepted');
    });
    return;
  }
  res.writeHead(404); res.end();
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], String(srv.address().port));
  process.stderr.write(`listening ${srv.address().port}\n`);
});

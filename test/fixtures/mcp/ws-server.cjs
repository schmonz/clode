// Minimal RFC6455 server speaking MCP, for measuring the WebSocket transport.
//
// Dependency-free ON PURPOSE: `ws` is not installed here, and adding it would
// make the measurement depend on the very thing being measured. Handshake plus
// text-frame encode/decode is about sixty lines, which is cheaper than that
// coupling.
//
// Set MCP_MOCK_WIRE to a path to record what actually arrived, so a test can
// assert on the wire rather than on what a client claims it sent.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
// RFC 6455 handshake GUID. Taken from ws/lib/constants.js, NOT from memory: it was
// first written here with the final group transposed, which made every handshake
// invalid. Both the engine's native WebSocket and node's `ws` correctly rejected
// it ("Invalid Sec-WebSocket-Accept header") — so the mock was broken, not either
// client, and any conclusion drawn from it about ws was worthless.
//
// The lesson is about instruments, not WebSockets: this file is the reference
// against which client behaviour is judged, so a bug HERE reads as a bug THERE.
// The handshake is checked against ws's own constant rather than trusted, and
// test/mcp-transport.test.cjs asserts the mock records what it received.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function decodeFrames(buf, onText, onClose, onPing) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off], b2 = buf[off + 1];
    const opcode = b1 & 0x0f, masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f, p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { mask = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) return off;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 0x1) onText(payload.toString('utf8'));
    else if (opcode === 0x8) onClose(payload);   // closing handshake
    else if (opcode === 0x9) onPing(payload);    // ping -> pong
    off = p + len;
  }
  return off;
}
// A control frame: close (0x8) or pong (0xA). Control payloads are always short,
// so the 7-bit length form is always correct here.
function encodeControl(opcode, payload) {
  const p = payload || Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x80 | opcode, p.length]), p]);
}
function encodeText(s) {
  const p = Buffer.from(s, 'utf8');
  if (p.length < 126) return Buffer.concat([Buffer.from([0x81, p.length]), p]);
  const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2);
  return Buffer.concat([h, p]);
}

const srv = http.createServer((_, res) => { res.writeHead(426); res.end(); });
srv.on('upgrade', (req, sock) => {
  process.stderr.write(`<< UPGRADE ${req.url}\n`);
  if (process.env.MCP_MOCK_WIRE) fs.appendFileSync(process.env.MCP_MOCK_WIRE, `UPGRADE ${req.url}\n`);
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
    + 'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let acc = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const used = decodeFrames(acc, (text) => {
      let msg = {}; try { msg = JSON.parse(text); } catch { /* */ }
      process.stderr.write(`<< WS method=${msg.method} id=${msg.id}\n`);
      if (msg.method === 'initialize') {
        sock.write(encodeText(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'wsprobe', version: '1.0.0' } } })));
      } else if (msg.method === 'tools/list') {
        sock.write(encodeText(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
          { name: 'needle', description: 'probe tool', inputSchema: { type: 'object', properties: {} } } ] } })));
        process.stderr.write('<< SERVED tools/list — MCP OVER WS REACHED TOOL DISCOVERY\n');
      }
    }, (payload) => {
      // Echo the close frame back and end the socket. Without this the peer never
      // sees the closing handshake: npm ws waits for it and never emits 'close',
      // which made a comparison look like a quaude-vs-node divergence when it was
      // only this server refusing to finish the conversation.
      process.stderr.write('<< CLOSE\n');
      if (process.env.MCP_MOCK_WIRE) fs.appendFileSync(process.env.MCP_MOCK_WIRE, 'CLOSE\n');
      try { sock.write(encodeControl(0x8, payload)); sock.end(); } catch { /* already gone */ }
    }, (payload) => {
      try { sock.write(encodeControl(0xA, payload)); } catch { /* already gone */ }
    });
    acc = acc.subarray(used);
  });
  sock.on('error', () => {});
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], String(srv.address().port));
  process.stderr.write(`listening ${srv.address().port}\n`);
});

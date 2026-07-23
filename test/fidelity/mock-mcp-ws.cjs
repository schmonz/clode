'use strict';
// A mock MCP server that speaks JSON-RPC 2.0 over a WebSocket — the transport the
// bundle uses (`new WebSocket(url, {protocols:["mcp"]})`, Phase-2 native WS under
// quaude). Answers the MCP handshake (initialize / tools/list) and one tool
// (tools/call -> a text marker), and records which methods it saw. Needs the npm
// `ws` package as a SERVER (not in repo node_modules — resolved from the clode
// store); returns null if unavailable so the caller skips.
const os = require('node:os');
const path = require('node:path');

function loadWs() {
  try { return require('ws'); } catch (_) { /* not in repo */ }
  const stores = [path.join(os.homedir(), '.local/share/clode/node_modules/ws')];
  if (process.env.NODE_PATH) for (const d of process.env.NODE_PATH.split(path.delimiter)) stores.push(path.join(d, 'ws'));
  for (const p of stores) { try { return require(p); } catch (_) { /* keep trying */ } }
  return null;
}

function startMockMcpWs(opts = {}) {
  const WS = loadWs();
  if (!WS || !WS.WebSocketServer) return Promise.resolve(null);
  const { WebSocketServer } = WS;
  const toolName = opts.toolName || 'echo_needle';
  const marker = opts.marker || 'MCP-MARKER';
  const seen = [];
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      port: 0, host: '127.0.0.1',
      handleProtocols: (protocols) => (protocols && protocols.has && protocols.has('mcp')) ? 'mcp'
        : (protocols && protocols.values ? (protocols.values().next().value || false) : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        if (msg.method) seen.push(msg.method);
        if (msg.id === undefined || msg.id === null) return;   // JSON-RPC notification -> no reply
        const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        if (msg.method === 'initialize') {
          reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });
        } else if (msg.method === 'tools/list') {
          reply({ tools: [{ name: toolName, description: 'echo the needle', inputSchema: { type: 'object', properties: {} } }] });
        } else if (msg.method === 'tools/call') {
          reply({ content: [{ type: 'text', text: marker }] });
        } else {
          reply({});   // ping / anything else
        }
      });
    });
    wss.on('listening', () => {
      resolve({ url: `ws://127.0.0.1:${wss.address().port}`, seen, toolName, close: () => new Promise((r) => wss.close(() => r())) });
    });
  });
}

module.exports = { startMockMcpWs };

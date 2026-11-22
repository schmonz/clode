'use strict';
// Every TCP connection, request, upgrade and close a mock MCP server sees, each with the wall-clock ms it happened
// at, appended to MCP_MOCK_EVENTS (when set). The wire (MCP_MOCK_WIRE) says WHAT arrived; this says whether anything
// reached the socket at all and WHEN, so "(nothing arrived)" can tell a client that never connected from one that
// connected and never sent the GET, or sent the GET and never the POST (scripts/mcp-transport-probe.mjs prints it
// against the client's own spawn time). CI 45040226669, windows-amd64: a 45s "(nothing arrived)" with no way to say
// which.
const fs = require('node:fs');

function eventLog(line) {
  if (!process.env.MCP_MOCK_EVENTS) return;
  try { fs.appendFileSync(process.env.MCP_MOCK_EVENTS, `${Date.now()} ${line}\n`); } catch { /* the mock must not die of its log */ }
}

function attachEvents(srv) {
  let n = 0;
  srv.on('connection', (sock) => {
    const id = ++n;
    eventLog(`connect #${id} from ${sock.remoteAddress}:${sock.remotePort}`);
    sock.on('close', () => eventLog(`close #${id}`));
  });
  srv.on('request', (req) => eventLog(`request ${req.method} ${req.url}`));
  srv.on('upgrade', (req) => eventLog(`upgrade ${req.url}`));
  srv.on('listening', () => eventLog(`listening ${JSON.stringify(srv.address())}`));
}

module.exports = { attachEvents, eventLog };

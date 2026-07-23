'use strict';
// Per-leg WebSocket oracle: runs under the node-shim loader (tjs). Requires the
// shim so globalThis.WebSocket is BunWebSocket delegating to the native WS, then
// round-trips an echo through an in-process tjs.serve server and confirms the
// server saw a custom Authorization header. Prints "RESULT PASS" / "RESULT FAIL".
require(process.env.CLODE_BUN_SHIM);   // installs BunWebSocket -> native delegation

let seenAuth = null;
const server = tjs.serve({
  port: 0, listenIp: '127.0.0.1',
  fetch(request, { server }) {
    if (request.headers.get('upgrade') === 'websocket') {
      seenAuth = request.headers.get('authorization');
      server.upgrade(request);
      return;
    }
    return new Response('no');
  },
  websocket: { message(ws, data) { ws.sendText('echo:' + data); } },
});

// headers only — a bare tjs.serve does not grant subprotocols (see plan note)
const ws = new globalThis.WebSocket('ws://127.0.0.1:' + server.port, { headers: { Authorization: 'Bearer tok123' } });
ws.onopen = () => ws.send('ping');
ws.onmessage = (e) => {
  const pass = (e.data === 'echo:ping' && seenAuth === 'Bearer tok123');
  console.log('RESULT ' + (pass ? 'PASS' : 'FAIL') + ' (echo=' + e.data + ' auth=' + seenAuth + ')');
  try { ws.close(); } catch (_) {}
  try { server.close && server.close(); } catch (_) {}
};
ws.onerror = (e) => console.log('RESULT FAIL (error ' + (e && (e.message || e.type)) + ')');

'use strict';
// A ws-SHAPED consumer, written to match what the 2.1.238 bundle actually does:
// the EventEmitter API plus `readyState === OPEN ? close(code,reason) : terminate()`.
// Under Node this drives npm ws; under tjs it drives the engine's native WebSocket
// wearing the ws surface (bun-shim's _wsShape), so the two can be diffed.
if (process.env.CLODE_BUN_SHIM) require(process.env.CLODE_BUN_SHIM);
const WS = process.env.WS_PATH ? require(process.env.WS_PATH) : require('ws');
const ws = new WS(process.env.WS_URL);
const seen = [];
const done = () => { console.log(JSON.stringify(seen)); };
ws.on('open', () => {
  seen.push('open');
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
});
ws.on('message', (data, isBinary) => {
  seen.push('message:' + String(data).slice(0, 24) + ':isBinary=' + !!isBinary);
  ws.removeAllListeners('message');          // the bundle calls this
  if (ws.readyState === WS.OPEN) ws.close(1000, 'done'); else ws.terminate();
});
ws.on('close', (code) => { seen.push('close:' + code); done(); });
ws.on('error', (e) => { seen.push('error:' + e.message); done(); });
setTimeout(() => { seen.push('TIMEOUT'); done(); }, 6000);

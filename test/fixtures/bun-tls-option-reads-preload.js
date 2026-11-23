// Records which keys native Bun's fetch, WebSocket and Bun.FetchSession READ from a `tls` options object: the list
// test/fixtures/bun-tls-option-reads-native.json holds, and test/node-shim-tls-options.test.cjs requires bun-shim's
// fetch/WebSocket table (libexec/bun-shim.cjs _checkBunTls) to name in full.
//
// Re-record (no credentials, no network: the connection target is a closed local port; Bun reads the options while
// building the request, before connecting), with a throwaway HOME:
//   env -i PATH=/usr/bin:/bin HOME=<tmp> OUTF=<file> BUN_OPTIONS="--preload <this file>" <native claude> --version
// An empty or missing OUTF means the preload was ignored: a refusal, never a pass.
const fs = require('fs');

function recorder(base, seen) {
  return new Proxy(base, {
    get(t, k, r) { if (typeof k === 'string') seen.add(k); return Reflect.get(t, k, r); },
    has(t, k) { if (typeof k === 'string') seen.add(k); return Reflect.has(t, k); },
  });
}
const out = { bun: Bun.version };
(async () => {
  const fetchTls = new Set();
  try { await fetch('https://127.0.0.1:1/', { tls: recorder({}, fetchTls) }); } catch (_) { /* refused: expected */ }
  const wsTls = new Set();
  try {
    const ws = new WebSocket('wss://127.0.0.1:1/', { tls: recorder({}, wsTls) });
    await new Promise((res) => { ws.onerror = res; ws.onclose = res; setTimeout(res, 2000); });
  } catch (_) { /* refused: expected */ }
  const sessionTls = new Set();
  try { new Bun.FetchSession({ tls: recorder({}, sessionTls) }); } catch (_) { /* absent in this Bun */ }
  out.fetch = [...fetchTls].sort();
  out.WebSocket = [...wsTls].sort();
  out.FetchSession = [...sessionTls].sort();
  fs.writeFileSync(process.env.OUTF, JSON.stringify(out, null, 1) + '\n');
  process.exit(0);
})();

// THE BUN HALF OF THE OPTIONS CENSUS (test/options-census.test.cjs): which keys native Bun READS from the options
// object a caller hands fetch (its init), Bun.spawn, Bun.spawnSync and WebSocket. Recorded inside native Claude Code's
// own Bun with a Proxy that notes every get/has; Bun's natives read the caller's object directly (no copy), so the
// Proxy sees each read. The tls sub-object is its own census (bun-tls-option-reads-preload.js beside this file).
//
// Re-record (no credentials, no network: fetch and WebSocket aim at a closed local port and the children are
// /usr/bin/true), with a throwaway HOME, then copy OUTF over test/fixtures/options-census-bun-native.json:
//   env -i PATH=/usr/bin:/bin HOME=<tmp> OUTF=<file> BUN_OPTIONS="--preload <this file>" <native claude> --version
// An empty or missing OUTF means the preload was ignored: a refusal, never a pass. Bun reads some keys only on some
// platforms (windowsHide, windowsVerbatimArguments: win32 only), so the fixture records the platform it came from.
const fs = require('fs');

function recorder(base, seen) {
  return new Proxy(base, {
    get(t, k, r) { if (typeof k === 'string') seen.add(k); return Reflect.get(t, k, r); },
    has(t, k) { if (typeof k === 'string') seen.add(k); return Reflect.has(t, k); },
  });
}
const out = { bun: Bun.version, platform: `${process.platform}-${process.arch}`, entries: {} };
(async () => {
  const f = new Set();
  for (const u of ['http://127.0.0.1:1/', 'https://127.0.0.1:1/']) {
    try { await fetch(u, recorder({}, f)); } catch (_) { /* refused: expected */ }
  }
  out.entries.fetch = [...f].sort();
  for (const [name, run] of [['Bun.spawn', async (o) => { await Bun.spawn(o.cmd ? o : ['/usr/bin/true'], o.cmd ? undefined : o).exited; }],
    ['Bun.spawnSync', async (o) => { Bun.spawnSync(o.cmd ? o : ['/usr/bin/true'], o.cmd ? undefined : o); }]]) {
    const s = new Set();
    // both call shapes: (argv, options) and (options-with-cmd)
    try { await run(recorder({}, s)); } catch (e) { out[`${name}:error`] = String(e); }
    try { await run(recorder({ cmd: ['/usr/bin/true'] }, s)); } catch (e) { out[`${name}:error2`] = String(e); }
    out.entries[name] = [...s].sort();
  }
  const w = new Set();
  try {
    const ws = new WebSocket('ws://127.0.0.1:1/', recorder({}, w));
    await new Promise((res) => { ws.onerror = res; ws.onclose = res; setTimeout(res, 2000); });
  } catch (_) { /* refused: expected */ }
  out.entries.WebSocket = [...w].sort();
  fs.writeFileSync(process.env.OUTF, JSON.stringify(out, null, 1) + '\n');
  process.exit(0);
})();

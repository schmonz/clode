'use strict';
// An https request body reaches the server WHOLE under node-shim, at every size, as it does under node.
//
// FOUND (2026-11-24): 2.1.330's Datadog log flush (an axios POST of a ~37 KB JSON body) logged `AxiosError: timeout
// of 5000ms exceeded` under quaude on every turn long enough to batch that much, and naude logged nothing. The
// engine's TLS write (mod_tls.c tjs_tls_write) called mbedtls_ssl_write ONCE; mbedtls takes at most one record
// (~16 KiB) per call and the rest was dropped while write() reported success. The server got the head and one
// record, waited for the rest of its Content-Length, and the caller's timer fired. 16383 bytes arrived; 16384 did not.
// Every earlier https row posted a few bytes, which is why nothing saw it.
//
// THE CLASS this holds: the shim's https client completing a request differently from node -- a body cut short, a
// response that never comes -- with a child process running beside it (the Datadog case ran during a Bash `sleep 20`).
// Differential: the same probe under host node (the oracle) and under tjs + node-shim, against one origin; every row
// must match node's, and every request must finish well inside the time a stall would take.
//
// Fixed by spike/quickjs/patches/txiki-tls-write-all.patch (the write loops until mbedtls has every byte; floored by
// scripts/engine-api-floor.cjs as __tjs_tls_write_all), and on an engine without it node-shim's https client cuts its
// TLS writes into pieces one record holds (libexec/node-shim/modules/http.cjs, TLS_SAFE_WRITE): the stale-engine row
// below drives that route.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { selfSignedCert } = require('./self-signed-cert.cjs');
const { skipUnlessTjs, engineSpawn, LOADER } = require('./node-shim-helper.cjs');
const { makeStaleHost, refusals, mkdtemp } = require('./stale-build-host.cjs');

const PROBE = path.join(__dirname, 'fixtures', 'https-write-sizes-probe.cjs');
// node finishes each request in a few ms; a dropped tail is a request that never finishes (the probe gives up at 10 s).
const FINISH_MS = 3000;

function origin(cert, key) {
  const srv = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    req.on('data', (d) => { n += d.length; h.update(d); });
    req.on('end', () => res.end(`${n} ${h.digest('hex')}`));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), 180000);
    c.on('close', (code) => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out)); } catch { resolve({ failed: `exit ${code}; stdout ${out.slice(-300)}; stderr ${err.slice(-1500)}` }); }
    });
  });
}

function compare(label, node, shim) {
  assert.ok(!node.failed, `host node probe failed: ${node.failed}`);
  assert.ok(!shim.failed, `${label} probe failed: ${shim.failed}`);
  for (const k of Object.keys(node.rows)) assert.strictEqual(node.rows[k], 'ok', `host node row '${k}': ${node.rows[k]}`);
  const bad = Object.keys(node.rows).filter((k) => shim.rows[k] !== node.rows[k]).map((k) => `${k}: ${shim.rows[k]} (${shim.ms[k]} ms)`);
  assert.deepStrictEqual(bad, [], `${label}: request bodies node delivers whole did not arrive (or no answer came):\n  ${bad.join('\n  ')}`);
  const slow = Object.keys(shim.ms).filter((k) => shim.ms[k] > FINISH_MS).map((k) => `${k}: ${shim.ms[k]} ms (node ${node.ms[k]} ms)`);
  assert.deepStrictEqual(slow, [], `${label}: requests took longer than ${FINISH_MS} ms:\n  ${slow.join('\n  ')}`);
}

test('https request bodies of every size arrive whole under node-shim, as under node, with a child running', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('no openssl on PATH; cannot mint a test certificate'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-sizes-'));
  const { cert, key } = selfSignedCert(dir, { cn: 'localhost', san: 'DNS:localhost,IP:127.0.0.1', days: 2, stdio: 'ignore' });
  const srv = await origin(cert, key);
  const env = { PROBE_PORT: String(srv.address().port), PROBE_CA: cert };
  try {
    const node = await run(process.execPath, [PROBE], env);
    const [cmd, argv] = engineSpawn(['run', LOADER, PROBE]);
    compare('tjs + node-shim', node, await run(cmd, argv, env));

    // The route an engine without txiki-tls-write-all.patch takes: node-shim cuts each TLS write, and says so.
    const staleDir = mkdtemp('https-sizes');
    try {
      const host = makeStaleHost(staleDir);
      if (host.skip) { t.diagnostic(`stale-engine row skipped: ${host.skip}`); return; }
      compare('tjs + node-shim on a stale engine', node, await run(host.engine, ['run', LOADER, PROBE], { ...env, ...host.env }));
      assert.match(refusals(host, '').wire, /no __tjs_tls_write_all/, 'the stale engine\'s cut writes were not named in CLODE_ENGINE_FLOOR_LOG');
    } finally { fs.rmSync(staleDir, { recursive: true, force: true }); }
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

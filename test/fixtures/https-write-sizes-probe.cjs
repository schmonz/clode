'use strict';
// Run unchanged under host node and under tjs + node-shim (test/node-shim-https-write-sizes.test.cjs). POSTs bodies
// on both sides of the TLS record size (16 KiB), in the three shapes a caller writes a body in, to PROBE_PORT, while a
// child process runs beside them (2.1.330's Datadog flush timed out on a turn whose Bash call ran `sleep 20`). Prints
// one JSON row per request: what the server answered (bytes it received + their sha256), or TIMEOUT / the error.
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PROBE_PORT);
const ca = fs.readFileSync(process.env.PROBE_CA);
const SIZES = [0, 1, 16383, 16384, 16385, 37213, 262144];
const SHAPES = {
  'end(body)': (req, b) => req.end(b),
  'write(body)+end()': (req, b) => { req.write(b); req.end(); },
  'write(half)x2+end()': (req, b) => { req.write(b.subarray(0, b.length >> 1)); req.write(b.subarray(b.length >> 1)); req.end(); },
};
const LIMIT_MS = 10000;   // node answers each of these in a few ms; a dropped tail waits for ever

function post(body, shape) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/', ca,
      headers: { 'content-length': body.length } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ answer: `${res.statusCode} ${text}`, ms: Date.now() - t0 }));
    });
    req.setTimeout(LIMIT_MS, () => { req.destroy(); resolve({ answer: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ answer: `error ${e.code || e.message}`, ms: Date.now() - t0 }));
    SHAPES[shape](req, body);
  });
}

(async () => {
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'ping -n 61 127.0.0.1 >NUL'], { stdio: 'ignore' })
    : spawn('sleep', ['60'], { stdio: 'ignore' });
  const rows = {};
  const ms = {};
  try {
    for (const n of SIZES) {
      const body = Buffer.alloc(n);
      for (let i = 0; i < n; i++) body[i] = (i * 7 + 3) & 0xff;
      const want = `200 ${n} ${crypto.createHash('sha256').update(body).digest('hex')}`;
      for (const shape of Object.keys(SHAPES)) {
        const r = await post(body, shape);
        rows[`${n} ${shape}`] = r.answer === want ? 'ok' : r.answer;
        ms[`${n} ${shape}`] = r.ms;
      }
    }
  } finally { child.kill(); }
  process.stdout.write(JSON.stringify({ rows, ms }));
  process.exit(0);
})();

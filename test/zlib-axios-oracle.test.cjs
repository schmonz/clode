'use strict';
// axios through node-shim's http client settles exactly as it does under node, against a server that answers the way
// platform.claude.com's token endpoint does: status 400, a JSON body, and the body compressed in whatever the request
// accepted (Cloudflare picks br when offered, else gzip).
//
// WHY. The 2026-11-22 live /login on the NetBSD/arm64 VM, once it could connect, still failed with "Couldn't get an
// answer from the sign-in service". The bundle's axios asks for br whenever `typeof zlib.createBrotliDecompress ===
// "function"`; the shim's zlib had every (de)compressor present and throwing, so the server answered in br, the
// decoder threw, and axios rejected with no `response`, which the sign-in code reports as no answer at all. Native
// shows the server's invalid-code error (HTTP 400). Also in the way, and fixed with it: stream.pipeline did not take
// node's array form (axios chains its decoder with `pipeline([res, ...decoders], cb)`).
//
// THE ORACLE is host node running the same axios script against the same server. The bundle's own axios is a reduced
// copy of axios 1.15.2 (it embeds "axios/1.15.2"); this test runs that version from npm (test/package.json), with the
// bundle's options for the token POST: adapter 'http', maxRedirects 0, validateStatus 2xx.
//
// Placed in node-shim-oracle-darwin (test/ci-gates.cjs FILES), which has an engine and installs test/node_modules
// first, so a skip there is a finding rather than a quiet pass.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { tjsPath, engineSpawn, LOADER } = require('./node-shim-helper.cjs');

function axiosPath() {
  // axios's CommonJS build (its package `main` is the ES module); resolved from test/node_modules.
  try { return require.resolve('axios/dist/node/axios.cjs', { paths: [__dirname] }); } catch { return null; }
}

function skipReason() {
  if (!tjsPath()) return 'no tjs engine (CLODE_TJS)';
  if (!axiosPath()) return 'axios is not installed under test/ (npm install --prefix test)';
  return null;
}

const ERROR_BODY = { type: 'error', error: { type: 'invalid_grant', message: 'Invalid authorization code' } };

// How each row's server encodes its answer. `negotiate` is Cloudflare's: br if accepted, else gzip, else identity.
const ENCODERS = {
  br: (b) => zlib.brotliCompressSync(b),
  gzip: (b) => zlib.gzipSync(b),
  deflate: (b) => zlib.deflateSync(b),
  'deflate-raw': (b) => zlib.deflateRawSync(b),   // sent as "deflate": axios adds the zlib header itself
  identity: (b) => b,
  corrupt: (b) => Buffer.concat([zlib.gzipSync(b).subarray(0, 10), Buffer.from('not a deflate stream at all')]),
};
function pickEncoding(row, acceptEncoding) {
  if (row.encoding !== 'negotiate') return row.encoding;
  const offered = acceptEncoding.split(',').map((s) => s.trim().split(';')[0]);
  return ['br', 'gzip'].find((e) => offered.indexOf(e) !== -1) || 'identity';
}

function startServer(row) {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const enc = pickEncoding(row, String(req.headers['accept-encoding'] || ''));
      const body = ENCODERS[enc](Buffer.from(JSON.stringify(row.body)));
      const headers = {
        'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', vary: 'Accept-Encoding',
        'request-id': 'req_test', 'x-content-type-options': 'nosniff',
      };
      const wire = { br: 'br', gzip: 'gzip', deflate: 'deflate', 'deflate-raw': 'deflate', corrupt: 'gzip' }[enc];
      if (wire) headers['content-encoding'] = wire;
      if (row.chunked) {
        res.writeHead(row.status, headers);
        // A body in small writes, so the decoder sees it split mid-stream.
        for (let i = 0; i < body.length; i += 5) res.write(body.subarray(i, i + 5));
        res.end();
      } else {
        headers['content-length'] = body.length;
        res.writeHead(row.status, headers);
        res.end(body);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// The decoders themselves, without axios: each format piped through its create* stream in 3-byte writes, and a
// corrupt body's 'error'. Prints one JSON line; run under node and under the shim.
const DECODERS = `
const zlib = require('zlib');
const text = JSON.stringify({ error: 'invalid_grant', pad: 'x'.repeat(2000) });
const src = Buffer.from(process.argv[2], 'base64');
const cases = JSON.parse(src.toString());
const out = {};
let pending = cases.length;
for (const [name, make, b64] of cases) {
  const z = zlib[make]({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const data = Buffer.from(b64, 'base64');
  const got = [];
  z.on('data', (d) => got.push(d));
  z.on('error', (e) => { out[name] = { error: e.code, errno: e.errno }; if (--pending === 0) done(); });
  z.on('end', () => { const s = Buffer.concat(got).toString(); out[name] = { ok: s === text, length: s.length }; if (--pending === 0) done(); });
  for (let i = 0; i < data.length; i += 3) z.write(data.subarray(i, i + 3));
  z.end();
}
function done() { const s = {}; for (const k of Object.keys(out).sort()) s[k] = out[k]; console.log(JSON.stringify(s)); }
`;

const CLIENT = `
const axios = require(process.argv[2]);
axios.post(process.argv[3], { grant_type: 'authorization_code', code: 'garbage', state: 'garbage' }, {
  headers: { 'Content-Type': 'application/json' }, timeout: 30000,
  maxRedirects: 0, adapter: 'http', validateStatus: (s) => s >= 200 && s < 300,
}).then(
  (r) => console.log(JSON.stringify({ settled: 'resolved', status: r.status, data: r.data })),
  (e) => console.log(JSON.stringify({ settled: 'rejected', isAxiosError: e.isAxiosError === true, code: e.code ?? null,
    hasResponse: e.response !== undefined, status: e.response ? e.response.status : null,
    data: e.response ? e.response.data : null })));
`;

function run(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      let parsed = null; try { parsed = JSON.parse(line); } catch { /* reported below */ }
      resolve({ code, out, err, parsed });
    });
  });
}

let scriptDir;
function script(name, text) {
  if (!scriptDir) scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlib-axios-oracle-'));
  const f = path.join(scriptDir, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, text);
  return f;
}
const clientScript = () => script('client.cjs', CLIENT);
test.after(() => { if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }); });

async function bothEngines(row) {
  const srv = await startServer(row);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v1/oauth/token`;
    const args = [clientScript(), axiosPath(), url];
    const node = await run(process.execPath, args);
    const [cmd, argv] = engineSpawn(['run', LOADER, ...args]);
    const shim = await run(cmd, argv);
    assert.ok(node.parsed, `node printed no outcome:\n${node.out}\n${node.err}`);
    assert.ok(shim.parsed, `axios under the shim printed no outcome:\n${shim.out}\n${shim.err}`);
    return { node: node.parsed, shim: shim.parsed };
  } finally { srv.close(); }
}

const ROWS = [
  { name: 'the token endpoint\'s invalid-code answer: 400, JSON, Cloudflare\'s encoding negotiation',
    status: 400, body: ERROR_BODY, encoding: 'negotiate' },
  { name: '400 gzip, written in small chunks', status: 400, body: ERROR_BODY, encoding: 'gzip', chunked: true },
  { name: '400 deflate (zlib-wrapped)', status: 400, body: ERROR_BODY, encoding: 'deflate' },
  { name: '400 deflate sent raw (axios adds the zlib header)', status: 400, body: ERROR_BODY, encoding: 'deflate-raw' },
  { name: '400 uncompressed', status: 400, body: ERROR_BODY, encoding: 'identity' },
  { name: 'a successful exchange: 200 gzip resolves with the parsed body', status: 200,
    body: { access_token: 'x', token_type: 'bearer', expires_in: 3600 }, encoding: 'gzip', chunked: true },
  // No corrupt-body row here: under node, axios 1.15.2 never settles on a corrupt gzip body (the process just runs
  // out of work and exits 0), so there is no node outcome to match. The decoder's own error is held below instead.
];

for (const row of ROWS) {
  test(`axios under node-shim settles as under node: ${row.name}`, async (t) => {
    const why = skipReason();
    if (why) { t.skip(why); return; }
    const { node, shim } = await bothEngines(row);
    assert.deepStrictEqual(shim, node);
  });
}

test('zlib\'s decompressing streams decode, and fail, as node\'s do', async (t) => {
  if (!tjsPath()) { t.skip('no tjs engine (CLODE_TJS)'); return; }
  const text = Buffer.from(JSON.stringify({ error: 'invalid_grant', pad: 'x'.repeat(2000) }));
  const b64 = (b) => b.toString('base64');
  const cases = [
    ['gunzip', 'createGunzip', b64(zlib.gzipSync(text))],
    ['inflate', 'createInflate', b64(zlib.deflateSync(text))],
    ['inflateRaw', 'createInflateRaw', b64(zlib.deflateRawSync(text))],
    ['unzip of gzip', 'createUnzip', b64(zlib.gzipSync(text))],
    ['unzip of zlib', 'createUnzip', b64(zlib.deflateSync(text))],
    ['corrupt gzip', 'createGunzip', b64(Buffer.concat([zlib.gzipSync(text).subarray(0, 10), Buffer.from('garbage!')]))],
  ];
  const args = [script('decoders.cjs', DECODERS), b64(Buffer.from(JSON.stringify(cases)))];
  const node = await run(process.execPath, args);
  const [cmd, argv] = engineSpawn(['run', LOADER, ...args]);
  const shim = await run(cmd, argv);
  assert.ok(node.parsed, `node printed no outcome:\n${node.out}\n${node.err}`);
  assert.ok(shim.parsed, `the shim printed no outcome:\n${shim.out}\n${shim.err}`);
  assert.deepStrictEqual(shim.parsed, node.parsed);
});

// axios asks for br exactly when createBrotliDecompress is a function, so the shim's zlib may offer it only if it can
// decode it. A present-but-throwing brotli is the 2026-11-22 /login failure.
test('zlib offers brotli only if it can decode it', async (t) => {
  if (!tjsPath()) { t.skip('no tjs engine (CLODE_TJS)'); return; }
  const br = b64url(zlib.brotliCompressSync(Buffer.from('brotli body')));
  const probe = script('brotli.cjs', `
const zlib = require('zlib');
if (typeof zlib.createBrotliDecompress !== 'function') { console.log(JSON.stringify({ offered: false })); }
else {
  const z = zlib.createBrotliDecompress(); const got = [];
  z.on('data', (d) => got.push(d));
  z.on('error', (e) => console.log(JSON.stringify({ offered: true, decoded: false, error: String(e && e.message) })));
  z.on('end', () => console.log(JSON.stringify({ offered: true, decoded: Buffer.concat(got).toString() === 'brotli body' })));
  try { z.end(Buffer.from(process.argv[2], 'base64url')); } catch (e) { console.log(JSON.stringify({ offered: true, decoded: false, error: e.message })); }
}`);
  const [cmd, argv] = engineSpawn(['run', LOADER, probe, br]);
  const r = await run(cmd, argv);
  assert.ok(r.parsed, `no outcome:\n${r.out}\n${r.err}`);
  if (r.parsed.offered) assert.strictEqual(r.parsed.decoded, true, `zlib offers brotli but cannot decode it: ${r.parsed.error}`);
});
function b64url(b) { return b.toString('base64url'); }

// The specific shape the sign-in code reports as "Couldn't get an answer": an axios error with no response. Held
// separately so the failure names the user-visible symptom, not just a deep-equal diff.
test('the invalid-code answer reaches the caller as HTTP 400 with its body, not as an error with no response', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { shim } = await bothEngines(ROWS[0]);
  assert.strictEqual(shim.settled, 'rejected');
  assert.strictEqual(shim.hasResponse, true, 'no response: /login would say "Couldn\'t get an answer from the sign-in service"');
  assert.strictEqual(shim.status, 400);
  assert.deepStrictEqual(shim.data, ERROR_BODY);
});

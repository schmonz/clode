'use strict';
// node-shim's zlib one-shot helpers (gzipSync/deflateSync/deflateRawSync, gunzipSync/inflateSync/inflateRawSync/
// unzipSync, their callback forms and crc32) against host node, on the same inputs.
//
// WHY. They threw "node-shim: zlib.gzipSync not implemented", and 2.1.330 gzips every first-party event batch with
// zlib.gzipSync (and Bun.gzipSync): a live NetBSD/arm64 quaude --debug-file log (2026-11-23) read
// `[ERROR] 1P event logging: 181 events failed to export (node-shim: zlib.gzipSync not implemented ...)`, and the
// batches piled up on disk as <config>/telemetry/1p_failed_events.*.json (1.9 MB in one session). Native sends them.
// They are now miniz, synchronously, through the engine's __tjs_zlib_sync (txiki-zlib-sync.patch).
//
// THE ORACLE is host node. Compressed bytes are each compressor's own choice (miniz is not zlib), so what must agree
// is: node's zlib inflates quaude's output back to the input, quaude inflates node's output back to the input, the
// zlib and gzip HEADERS are node's bytes, every refusal carries node's code and errno (and node's words, except the
// one named in zlib.cjs: a corrupt deflate block), and the compression is real (a repetitive input shrinks).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// Inputs, deterministic. `text` is repetitive (it must shrink), `noise` is not (an LCG; it must survive).
const INPUTS = (() => {
  const noise = Buffer.alloc(20000);   // kept small: every output crosses a pipe as base64
  let x = 12345;
  for (let i = 0; i < noise.length; i++) { x = (x * 1103515245 + 12345) >>> 0; noise[i] = x >>> 24; }
  return {
    empty: Buffer.alloc(0),
    hello: Buffer.from('hello'),
    text: Buffer.from('{"event_name":"tengu_startup","session_id":"0000"}\n'.repeat(4000)),
    noise,
  };
})();
const LEVELS = ['none', 0, 1, 6, 9];   // 'none': no options argument at all

// What either engine answers, as a file: argv[2] holds { inputs, levels, peer } (peer: the OTHER engine's compressed
// output, base64, which this one inflates) and the answer goes to argv[3]. Files, not argv or a pipe: the data is
// hundreds of KB.
const PROGRAM = `
const fs = require('fs');
const zlib = require('zlib');
const D = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const INPUTS = Object.fromEntries(Object.entries(D.inputs).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const LEVELS = D.levels;
const PEER = D.peer;
const out = { compressed: {}, peerBack: {}, errors: {}, crc: {}, callback: null };
for (const [name, input] of Object.entries(INPUTS)) {
  for (const level of LEVELS) {
    const opts = level === 'none' ? undefined : { level };
    const key = name + '@' + level;
    out.compressed[key] = {
      gzip: zlib.gzipSync(input, opts).toString('base64'),
      deflate: zlib.deflateSync(input, opts).toString('base64'),
      raw: zlib.deflateRawSync(input, opts).toString('base64'),
    };
  }
}
for (const [key, c] of Object.entries(PEER)) {
  const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  const r = (f, b) => { try { return sha(f(Buffer.from(b, 'base64'))); } catch (e) { return 'THREW ' + e.code + ' ' + e.message; } };
  out.peerBack[key] = { gunzip: r(zlib.gunzipSync, c.gzip), inflate: r(zlib.inflateSync, c.deflate), raw: r(zlib.inflateRawSync, c.raw),
    unzipGz: r(zlib.unzipSync, c.gzip), unzipZ: r(zlib.unzipSync, c.deflate) };
}
const gz = (s) => zlib.gzipSync(s);
const flip = (b, i) => { b = Buffer.from(b); b[i < 0 ? b.length + i : i] ^= 1; return b; };
const ERR = {
  truncatedGz: () => zlib.gunzipSync(gz('hello world hello').subarray(0, 15)),
  notGz: () => zlib.gunzipSync(Buffer.from('garbage-data')),
  notZlib: () => zlib.inflateSync(Buffer.from('garbage')),
  gzCrc: () => zlib.gunzipSync(flip(gz('hi'), -5)),
  zlibAdler: () => zlib.inflateSync(flip(zlib.deflateSync('abc'), -1)),
  emptyGunzip: () => zlib.gunzipSync(Buffer.alloc(0)),
  emptyInflateRaw: () => zlib.inflateRawSync(Buffer.alloc(0)),
  method: () => zlib.gunzipSync(Buffer.from('1f8b0900000000000013', 'hex')),
  zlibShort: () => zlib.inflateSync(Buffer.from('78bb00', 'hex')),
  zlibDict: () => zlib.inflateSync(Buffer.from('78bb00000001ff', 'hex')),
  unzipOne: () => zlib.unzipSync(Buffer.from('1f', 'hex')),
  trailingGarbage: () => zlib.gunzipSync(Buffer.concat([gz('a'), Buffer.from('zz')])),
  trailingZeros: () => zlib.gunzipSync(Buffer.concat([gz('a'), Buffer.from([0, 0, 0xff])])),
  members: () => zlib.gunzipSync(Buffer.concat([gz('a'), gz('b')])),
  danglingMember: () => zlib.gunzipSync(Buffer.concat([gz('a'), Buffer.from('1f8b', 'hex')])),
  zlibTrailing: () => zlib.inflateSync(Buffer.concat([zlib.deflateSync('x'), Buffer.from('zz')])),
  level: () => zlib.gzipSync('x', { level: 11 }),
  notBytes: () => zlib.gzipSync(5),
  object: () => zlib.deflateSync({}),
  arrayBuffer: () => zlib.gunzipSync(zlib.gzipSync(new Uint8Array([1, 2, 3]).buffer)),
  callbackType: () => zlib.gzip('x', {}, 5),
  crcType: () => zlib.crc32(5),
};
for (const [k, f] of Object.entries(ERR)) {
  try { const r = f(); out.errors[k] = { ok: Buffer.isBuffer(r) ? r.toString('hex') : String(r) }; }
  catch (e) { out.errors[k] = { name: e.name, code: e.code, errno: e.errno, message: e.message }; }
}
out.crc = { hello: zlib.crc32('hello'), cont: zlib.crc32('hello', 5), buf: zlib.crc32(Buffer.from('hello')), empty: zlib.crc32('') };
const cbInput = Buffer.from('callback '.repeat(100));
zlib.gzip(cbInput, (err, b) => {
  zlib.gunzip(b, { }, (err2, back) => {
    zlib.inflateRaw(Buffer.from('ff', 'hex'), (err3) => {
      out.callback = { err, err2, same: Buffer.compare(back, cbInput) === 0, err3: err3 && err3.code };
      fs.writeFileSync(process.argv[3], JSON.stringify(out));
    });
  });
});
`;

// Runs PROGRAM under node or quaude on `data`, and returns its answer.
function run(engine, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlib-sync-'));
  try {
    const entry = path.join(dir, 'p.cjs'), inFile = path.join(dir, 'in.json'), outFile = path.join(dir, 'out.json');
    fs.writeFileSync(entry, PROGRAM);
    fs.writeFileSync(inFile, JSON.stringify(data));
    if (engine === 'node') execFileSync(process.execPath, [entry, inFile, outFile]);
    else {
      const r = runLoader(entry, [inFile, outFile], { timeout: 120000 });
      assert.strictEqual(r.status, 0, String(r.stderr));
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// A small one-off program under quaude, its last stdout line as JSON.
function runQuaude(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlib-sync-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, src);
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    return JSON.parse(String(r.stdout).trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const inputsB64 = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, v.toString('base64')]));

test('zlib one-shot helpers: quaude and node read each other\'s output, with node\'s headers and errors', (t) => {
  if (skipUnlessTjs(t)) return;
  const node = run('node', { inputs: inputsB64, levels: LEVELS, peer: {} });
  const quaude = run('quaude', { inputs: inputsB64, levels: LEVELS, peer: node.compressed });
  const nodeBack = run('node', { inputs: {}, levels: LEVELS, peer: quaude.compressed }).peerBack;

  for (const [key, q] of Object.entries(quaude.compressed)) {
    const input = require('node:crypto').createHash('sha256').update(INPUTS[key.split('@')[0]]).digest('hex');
    const n = node.compressed[key];
    // node inflates quaude's output to the input; quaude inflates node's output to the input
    assert.deepStrictEqual(nodeBack[key], { gunzip: input, inflate: input, raw: input, unzipGz: input, unzipZ: input }, `node reading quaude's ${key}`);
    assert.deepStrictEqual(quaude.peerBack[key], { gunzip: input, inflate: input, raw: input, unzipGz: input, unzipZ: input }, `quaude reading node's ${key}`);
    // node's header bytes: gzip's 10 (XFL by level, OS by platform) and zlib's 2 (FLEVEL by level)
    const head = (b64, n) => Buffer.from(b64, 'base64').subarray(0, n).toString('hex');
    assert.strictEqual(head(q.gzip, 10), head(n.gzip, 10), `gzip header, ${key}`);
    assert.strictEqual(head(q.deflate, 2), head(n.deflate, 2), `zlib header, ${key}`);
  }
  // real compression, not stored blocks: the repetitive input shrinks at every level but 0, about as node's does
  for (const level of LEVELS.filter((l) => l !== 0)) {
    const q = Buffer.from(quaude.compressed[`text@${level}`].gzip, 'base64').length;
    const n = Buffer.from(node.compressed[`text@${level}`].gzip, 'base64').length;
    assert.ok(q < INPUTS.text.length / 20, `text@${level}: ${q} bytes of ${INPUTS.text.length} is not compression`);
    assert.ok(q < n * 4, `text@${level}: ${q} bytes where node needs ${n}`);
  }
  // errors: node's code and errno always; node's message except the one named divergence (none of these rows)
  assert.deepStrictEqual(quaude.errors, node.errors);
  assert.deepStrictEqual(quaude.crc, node.crc);
  assert.deepStrictEqual(quaude.callback, node.callback);
});

// The named divergence: a corrupt deflate BLOCK. node names the fault; miniz cannot, so the message differs, and
// only the message.
test('a corrupt deflate block: node\'s code and errno, miniz\'s words', (t) => {
  if (skipUnlessTjs(t)) return;
  const src = `const zlib = require('zlib');
try { zlib.inflateRawSync(Buffer.from('ffffffff', 'hex')); } catch (e) { console.log(JSON.stringify({ name: e.name, code: e.code, errno: e.errno, message: e.message })); }`;
  const n = JSON.parse(execFileSync(process.execPath, ['-e', src], { encoding: 'utf8' }));
  const q = runQuaude(src);
  assert.deepStrictEqual({ ...q, message: undefined }, { ...n, message: undefined });
  assert.strictEqual(n.message, 'invalid block type');
  assert.strictEqual(q.message, 'invalid compressed data');
});

test('an engine without __tjs_zlib_sync is refused by name, not answered', (t) => {
  if (skipUnlessTjs(t)) return;
  const src = `delete globalThis.__tjs_zlib_sync;
const zlib = require('zlib');
try { zlib.gzipSync('x'); console.log(JSON.stringify({ answered: true })); } catch (e) { console.log(JSON.stringify({ code: e.code, message: e.message })); }`;
  const q = runQuaude(src);
  assert.strictEqual(q.code, 'ERR_CLODE_ENGINE_FLOOR');
  assert.match(q.message, /__tjs_zlib_sync .*zlib\.gzipSync/);
});

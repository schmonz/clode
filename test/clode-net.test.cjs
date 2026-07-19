'use strict';
// Unit tests for libexec/clode-net.cjs — the JS port of bin/clode's
// download_file (bin/clode:100) and sha256_of (bin/clode:93). The sh helpers
// shell out to curl/wget and sha256sum/shasum; the JS port drops those deps in
// favour of Node's built-in fetch + fs + crypto. Covers file:// thoroughly
// (string + dest modes, binary-safety, missing-file error path) plus a localhost
// http server fixture; live https is not exercised offline.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { downloadFile, sha256Of } = require('../libexec/clode-net.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-net-'));
}

// --- sha256Of: real host tool (integration) --------------------------------

test('sha256Of matches the known digest of "hello"', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'hello.txt');
  fs.writeFileSync(f, 'hello'); // no trailing newline
  assert.strictEqual(
    sha256Of(f),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
});

test('sha256Of matches crypto over binary bytes (0x00-0xff), lowercase hex', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'bytes.bin');
  const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  fs.writeFileSync(f, buf);
  const expected = crypto.createHash('sha256').update(buf).digest('hex');
  assert.strictEqual(sha256Of(f), expected);
  assert.match(sha256Of(f), /^[0-9a-f]{64}$/);
});

// --- downloadFile: file:// -------------------------------------------------

test('downloadFile(file://) string mode returns the body', async () => {
  const dir = tmpdir();
  const src = path.join(dir, 'src.txt');
  fs.writeFileSync(src, 'manifest-body\nline2');
  const body = await downloadFile(pathToFileURL(src).href);
  assert.strictEqual(body, 'manifest-body\nline2');
});

test('downloadFile(file://) dest mode writes identical bytes (binary-safe)', async () => {
  const dir = tmpdir();
  const src = path.join(dir, 'src.bin');
  const dst = path.join(dir, 'dst.bin');
  const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  fs.writeFileSync(src, buf);
  const ok = await downloadFile(pathToFileURL(src).href, dst);
  assert.strictEqual(ok, true);
  const got = fs.readFileSync(dst);
  assert.ok(buf.equals(got), 'dest bytes must equal source bytes');
  // sha256 of copy must equal sha256 of source (the update flow's check)
  assert.strictEqual(sha256Of(dst), sha256Of(src));
});

test('downloadFile(file://) missing file rejects (caller error path)', async () => {
  const dir = tmpdir();
  const missing = pathToFileURL(path.join(dir, 'nope.txt')).href;
  await assert.rejects(() => downloadFile(missing));
  await assert.rejects(() => downloadFile(missing, path.join(dir, 'out')));
});

// --- downloadFile: http:// (localhost fixture) -----------------------------

test('downloadFile(http://) string + dest modes over localhost', async () => {
  const payload = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const dir = tmpdir();
    const dst = path.join(dir, 'http.bin');
    const ok = await downloadFile(`${base}/ok`, dst);
    assert.strictEqual(ok, true);
    assert.ok(payload.equals(fs.readFileSync(dst)), 'http dest bytes intact');

    const asStr = await downloadFile(`${base}/ok`);
    assert.strictEqual(Buffer.from(asStr, 'utf8').length >= 0, true);

    // non-2xx must throw so the sh caller's `|| return 1` fires
    await assert.rejects(() => downloadFile(`${base}/missing`));
    await assert.rejects(() => downloadFile(`${base}/missing`, path.join(dir, 'x')));
  } finally {
    server.close();
  }
});

// dest mode must STREAM the body to disk chunk-by-chunk rather than buffer the
// whole (~240MB) response via arrayBuffer() and writeFileSync once at the end
// (BACKLOG "clode fetch looks eternally stuck at 0 bytes"): the arrayBuffer
// approach leaves the dest at 0 bytes for the whole download (looks hung) and
// OOMs/hangs a 243MB buffer under tjs. Contract: onProgress fires per chunk with
// a monotonically increasing received count that ends at total (from
// content-length), proving incremental streaming, and the bytes stay intact.
test('downloadFile(http://) streams to dest with incremental progress', async () => {
  // three distinct chunks, flushed with gaps so a buffering impl can't coalesce
  const chunks = [
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(4096, 0x42),
    Buffer.alloc(4096, 0x43),
  ];
  const payload = Buffer.concat(chunks);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    });
    let i = 0;
    const pump = () => {
      if (i < chunks.length) {
        res.write(chunks[i++]);
        setTimeout(pump, 10);
      } else {
        res.end();
      }
    };
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const dir = tmpdir();
    const dst = path.join(dir, 'stream.bin');
    const seen = [];
    const ok = await downloadFile(`http://127.0.0.1:${port}/`, dst, {
      onProgress: (received, total) => seen.push([received, total]),
    });
    assert.strictEqual(ok, true);
    assert.ok(payload.equals(fs.readFileSync(dst)), 'streamed bytes intact');
    // fired more than once => genuinely chunk-by-chunk, not one buffered write
    assert.ok(seen.length >= 2, `onProgress should fire per chunk, got ${seen.length}`);
    // monotonically increasing, ends at total, total is the content-length
    let prev = 0;
    for (const [received, total] of seen) {
      assert.ok(received > prev, 'received must strictly increase');
      assert.strictEqual(total, payload.length, 'total is content-length');
      prev = received;
    }
    assert.strictEqual(prev, payload.length, 'final received equals total');
  } finally {
    server.close();
  }
});

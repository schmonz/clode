'use strict';
// clode-net.cjs — JS port of bin/clode's download + checksum helpers.
//
//   download_file (bin/clode:100)  ->  downloadFile(url, destPath?)  [async]
//   sha256_of     (bin/clode:93)   ->  sha256Of(path)
//
// The sh launcher shells out to curl/wget for downloads and sha256sum/shasum for
// checksums. Both drop those external tools: downloads use built-in fetch
// (http/https) and fs (file://); dropping curl/wget is an explicit project goal.
// sha256Of hashes natively in-process (tjs:hashing under tjs, node:crypto under
// node). See sha256Of below.
//
// Callers in the update flow (bin/clode:357/364/378 -> future clode-update):
//   - resolve version / manifest: capture the body as a string.
//   - fetch provider binary (~240MB): write to a dest file, then sha256Of() it.
// So downloadFile takes an optional destPath and either returns the body string
// (utf8) or writes the bytes to destPath and resolves true. On any failure
// (network error, non-2xx, missing file) it rejects, mirroring the sh callers'
// `|| return 1` / `if ! download_file ...` error paths.
//
// Binary-safety: dest-mode writes raw bytes (Buffer from arrayBuffer, or a byte
// copy for file://), never a utf8 round-trip, so a 240MB binary is not corrupted.

const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

// hex sha256 of a file's bytes -> lowercase, identical to `sha256sum` /
// `shasum -a 256` output (just the digest, no filename). The file is read in
// chunks into ONE native hash: txiki's tjs:hashing under tjs (the loader leaves
// it on globalThis.__clodeTjsHashing; mbedtls, ~320MB/s), node:crypto under node.
// Never a hash written in JS: the shim's old pure-JS SHA-256 pegged the main
// thread for minutes on the ~265MB provider (the "hangs writing to disk" report,
// really a silent post-download verify). Never a host tool either: that was the
// next answer, and Mac OS X Tiger has no sha256 tool, so a Tiger first run could
// not verify its download.
const HASH_CHUNK = 4 * 1024 * 1024;
function sha256Of(filePath) {
  const tjsHashing = globalThis.__clodeTjsHashing;
  const h = tjsHashing ? tjsHashing.createHash('sha256') : require('node:crypto').createHash('sha256');
  const buf = Buffer.alloc(HASH_CHUNK);
  // tjs:hashing's update() takes a TypedArray, not a bare ArrayBuffer: hand it a plain Uint8Array view.
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, HASH_CHUNK, null);
      if (n <= 0) break;
      h.update(view.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return tjsHashing ? h.digest() : h.digest('hex');
}

// GET a URL. url may be https://, http:// or file://.
//   - destPath omitted: resolve the body as a utf8 string (stdout-capture case).
//   - destPath given:   write raw bytes to destPath, resolve true (download case).
//   - opts.onProgress(received, total): called per response chunk in dest mode;
//     `total` is the content-length (0 if the server omits it).
// Rejects on failure so the caller's error path fires.
//
// Dest mode STREAMS res.body → destPath chunk-by-chunk (res.body.getReader(), a
// WHATWG primitive present under both host node and the tjs fetch). This replaces
// an earlier `Buffer.from(await res.arrayBuffer())` that buffered the ENTIRE
// (~240MB) provider binary in memory and wrote once at the end: the dest sat at 0
// bytes for the whole download (looked "eternally stuck"), and a 243MB arrayBuffer
// hangs/OOMs under tjs. Streaming removes the memory spike, shows real movement,
// and is robust under tjs.
async function downloadFile(url, destPath, opts) {
  const wantFile = destPath != null && destPath !== '';
  const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;

  if (url.startsWith('file://')) {
    const src = fileURLToPath(url);
    if (wantFile) {
      fs.copyFileSync(src, destPath); // byte-exact copy, binary-safe
      return true;
    }
    return fs.readFileSync(src, 'utf8');
  }

  // http(s): built-in fetch. redirect: 'follow' mirrors curl -L / wget defaults.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`clode: download failed (HTTP ${res.status}) for ${url}`);
  }
  if (wantFile) {
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const fd = fs.openSync(destPath, 'w');
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // value is a Uint8Array chunk; write it straight through, no buffering.
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        fs.writeSync(fd, buf, 0, buf.length);
        received += value.byteLength;
        if (onProgress) onProgress(received, total);
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }
  return await res.text();
}

// Fetch exactly [offset, offset+length) of a remote asset, for the templates
// blob: one published `templates-<pin>` holds every engine's gzip member, and a
// `--target X` build needs only its own ~2.4MB slice rather than the ~122MB whole.
//
// PROVEN BEFORE BUILT (spike 2026-07-27): tjs's libwebsockets `fetch` honors
// Range THROUGH the GitHub→CDN redirect — `Range: bytes=0-99` against a
// published `.gz` returned 206 with `content-range: bytes 0-99/2547550`, exactly
// 100 bytes, gzip magic intact. So this needs no new fetch backend and no
// redirect workaround on either engine.
//
// THE 200 FALLBACK IS NOT PARANOIA: a mirror or proxy that ignores Range answers
// 200 with the ENTIRE body. Treating that as success would hand the caller the
// whole blob where a slice was asked for, and the gzip inflate would then
// succeed (concatenated members are a valid single stream) and produce the WRONG
// engine — a silent, sha-caught-but-confusing failure. So a 200 is sliced
// locally and reported, and anything else throws.
async function fetchRange(url, offset, length, opts = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
    throw new Error(`clode: bad range (offset=${offset} length=${length}) for ${url}`);
  }
  const end = offset + length - 1;

  if (url.startsWith('file://')) {
    // Local blob served as a URL: seek+read, the same slice by another name.
    const fd = fs.openSync(fileURLToPath(url), 'r');
    try {
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, offset);
      if (got !== length) throw new Error(`clode: short read (${got} != ${length}) from ${url}`);
      return buf;
    } finally { fs.closeSync(fd); }
  }

  const res = await fetch(url, { redirect: 'follow', headers: { Range: `bytes=${offset}-${end}` } });
  if (res.status === 206) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== length) {
      throw new Error(`clode: range ${offset}-${end} returned ${buf.length} bytes, expected ${length} (${url})`);
    }
    return buf;
  }
  if (res.status === 200) {
    if (opts.onFallback) opts.onFallback();
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length < offset + length) {
      throw new Error(`clode: server ignored Range and the body is too short `
        + `(${whole.length} < ${offset + length}) for ${url}`);
    }
    return whole.subarray(offset, offset + length);
  }
  throw new Error(`clode: range request failed (HTTP ${res.status}) for ${url}`);
}

// Read a slice out of an already-downloaded blob on disk. The offline half of
// the same index: `CLODE_TEMPLATES_BLOB=/path/to/templates-<pin>` makes every
// engine an fs.read() and clode dials out for NOTHING. Deliberately shares the
// caller and the verify path with fetchRange so the two modes cannot drift.
function readRange(blobPath, offset, length) {
  const fd = fs.openSync(blobPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, offset);
    if (got !== length) {
      throw new Error(`clode: short read (${got} != ${length}) at ${offset} in ${blobPath}`);
    }
    return buf;
  } finally { fs.closeSync(fd); }
}

module.exports = { downloadFile, sha256Of, fetchRange, readRange };

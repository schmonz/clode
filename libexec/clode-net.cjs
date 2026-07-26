'use strict';
// clode-net.cjs — JS port of bin/clode's download + checksum helpers.
//
//   download_file (bin/clode:100)  ->  downloadFile(url, destPath?)  [async]
//   sha256_of     (bin/clode:93)   ->  sha256Of(path)
//
// The sh launcher shells out to curl/wget for downloads and sha256sum/shasum for
// checksums. Downloads drop those external tools — built-in fetch (http/https)
// and fs (file://); dropping curl/wget is an explicit project goal. sha256Of,
// however, stays an EXTERNAL dependency (like the sh launcher, and like our
// rg/bfs/ugrep): under the tjs target there is no native crypto, so a pure-JS
// SHA-256 of the ~265MB provider pegged the main thread for minutes (the "hangs
// writing to disk" report — really a silent post-download verify). It resolves
// its digest tool via host-provision.cjs's KAT-verified provision(). See
// sha256Of below.
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
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { provision, parseSha256 } = require('./host-provision.cjs');
const { spawnSync } = require('node:child_process');

let gunzipSeq = 0;

// hex sha256 of a file's bytes -> lowercase, identical to `sha256sum` /
// `shasum -a 256` output (just the digest, no filename). Resolves a host digest
// tool via provision (KAT-verified, cached) and FAILS LOUD if none exists — never
// a pure-JS fallback (that was the multi-minute main-thread grind on the tjs
// target). opts forward to provision for testing (env/findTool/spawn/fs/dataDir).
function sha256Of(filePath, opts = {}) {
  const { candidate, path: bin } = provision('sha256', opts);
  const spawn = opts.spawn || spawnSync;
  const r = spawn(bin, candidate.args(filePath), { encoding: 'utf8', maxBuffer: 1 << 20 });
  if (!r || r.status !== 0) {
    throw new Error(`clode: ${bin} failed to hash ${filePath} (status ${r ? r.status : 'spawn error'})`);
  }
  const digest = parseSha256(r.stdout);
  if (!digest) throw new Error(`clode: could not parse a sha256 digest from ${bin}`);
  return digest;
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

// In-process gzip inflate, present under BOTH host node and the tjs target
// (DecompressionStream + Response are WHATWG primitives tjs's fetch already
// carries). The no-tool fallback for gunzipBuffer — a ~5-7MB engine inflates in
// milliseconds, so a host without a gzip CLI still unpacks the pack.
async function gunzipViaStream(gzBytes) {
  if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') {
    throw new Error('clode: no gzip tool on PATH and no in-process gzip (DecompressionStream) — install gzip, or set CLODE_GZIP, to unpack the templates pack.');
  }
  const ds = new DecompressionStream('gzip');
  // Start draining BEFORE writing so a single large write can't deadlock on backpressure.
  const out = new Response(ds.readable).arrayBuffer();
  const w = ds.writable.getWriter();
  const u8 = gzBytes.byteOffset != null
    ? new Uint8Array(gzBytes.buffer, gzBytes.byteOffset, gzBytes.byteLength)
    : new Uint8Array(gzBytes);
  await w.write(u8);
  await w.close();
  return Buffer.from(await out);
}

// Inflate gzip bytes to a Buffer. PREFERS a native decompressor (fast — the
// project's exec-a-host-tool convention, like sha256Of/tar), resolved + KAT'd via
// host-provision; falls back to gunzipViaStream when no gzip CLI is on PATH. The
// caller sha256-verifies the INFLATED bytes, so a wrong/broken decompressor is
// caught there, never shipped. opts forward to provision (env/findTool/spawn/fs).
async function gunzipBuffer(gzBytes, opts = {}) {
  const spawn = opts.spawn || spawnSync;
  let tool = null;
  try { tool = provision('gzip', opts); } catch { tool = null; }
  if (tool) {
    const tmp = path.join(os.tmpdir(), `clode-gz-${process.pid}-${gunzipSeq++}.gz`);
    try {
      fs.writeFileSync(tmp, gzBytes);
      const r = spawn(tool.path, tool.candidate.args(tmp), { encoding: 'buffer', maxBuffer: 1 << 28 });
      if (r && r.status === 0 && r.stdout && r.stdout.length) return Buffer.from(r.stdout);
      // native tool present but this inflate failed → fall through to the stream path
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* absent */ }
    }
  }
  return gunzipViaStream(gzBytes);
}

module.exports = { downloadFile, sha256Of, gunzipBuffer };

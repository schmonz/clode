'use strict';
// clode-net.cjs — JS port of bin/clode's download + checksum helpers.
//
//   download_file (bin/clode:100)  ->  downloadFile(url, destPath?)  [async]
//   sha256_of     (bin/clode:93)   ->  sha256Of(path)
//
// The sh launcher shells out to curl/wget for downloads and sha256sum/shasum for
// checksums. This port drops those external tools: it uses Node's built-in fetch
// (http/https), fs (file://) and crypto (sha256). Dropping curl/wget is an
// explicit project goal.
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
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');

// hex sha256 of a file's bytes -> lowercase, identical to `sha256sum` /
// `shasum -a 256` output (just the digest, no filename).
function sha256Of(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

// GET a URL. url may be https://, http:// or file://.
//   - destPath omitted: resolve the body as a utf8 string (stdout-capture case).
//   - destPath given:   write raw bytes to destPath, resolve true (download case).
// Rejects on failure so the caller's error path fires.
async function downloadFile(url, destPath) {
  const wantFile = destPath != null && destPath !== '';

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
    const buf = Buffer.from(await res.arrayBuffer()); // raw bytes, binary-safe
    fs.writeFileSync(destPath, buf);
    return true;
  }
  return await res.text();
}

module.exports = { downloadFile, sha256Of };

'use strict';
// Node SEA helpers. All SEA behavior is gated on isSea(); everything is injectable
// (pass a `sea` object) so both branches unit-test without building a real SEA.
//
// Design note: rather than teach the shared launcher functions (extractIfNeeded,
// applyNodePath) about SEA, we materialize the embedded assets into ON-DISK layouts
// that mirror the npm/source tree — a depsRoot (whose node_modules holds the ext-deps)
// and a libexec (holding bun-shim.cjs + extract-claude-js.cjs). The rest of the
// launcher then runs UNCHANGED against those dirs, so SEA and source share one path.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function seaMod() { try { return require('node:sea'); } catch { return null; } }
function isSea(sea = seaMod()) { return !!(sea && sea.isSea && sea.isSea()); }

// Raw bytes of an embedded asset as a Buffer. getRawAsset returns an ArrayBuffer
// for binary assets; Buffer.from wraps it without copying the backing store.
function assetBuffer(sea, name) { return Buffer.from(sea.getRawAsset(name)); }

// Unpack the embedded deps tarball to a persistent, sig-keyed cache dir and return
// that dir — shaped like a clode DEPS_ROOT (it contains node_modules/), so the caller
// hands it to the normal launch path as depsRoot with no SEA-specific handling.
// Idempotent (skips if already unpacked) and atomic (temp dir + rename).
function materializeDeps({ sea = seaMod(), cacheDir }) {
  const sig = assetBuffer(sea, 'deps.sig').toString('utf8').trim();
  const dir = path.join(cacheDir, 'sea-deps', sig);
  if (fs.existsSync(path.join(dir, 'node_modules'))) return dir;   // already materialized
  const tmp = dir + '.partial-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); // clear a stale partial from a crashed run
  fs.mkdirSync(tmp, { recursive: true });
  const tarPath = path.join(tmp, 'deps.tar');
  fs.writeFileSync(tarPath, assetBuffer(sea, 'deps.tar'));
  execFileSync('tar', ['-xf', tarPath, '-C', tmp]);  // extracts a node_modules/ dir
  fs.rmSync(tarPath);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);                            // atomic publish
  return dir;
}

// Write the embedded libexec-shaped assets (bun-shim.cjs + extract-claude-js.cjs) into
// destDir and return it. Handed to extractIfNeeded as `libexec`, so its unchanged
// logic finds the shim (libexec/bun-shim.cjs) and fingerprints the extractor
// (sigOf(libexec/extract-claude-js.cjs)) exactly as in the npm/source layout.
function materializeLibexec({ sea = seaMod(), destDir }) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of ['bun-shim.cjs', 'extract-claude-js.cjs']) {
    const dest = path.join(destDir, name);
    const bytes = assetBuffer(sea, name);
    // Write only when missing or changed, so an unchanged extractor keeps its mtime.
    // extractIfNeeded fingerprints the extractor via sigOf (size-mtime); rewriting it
    // every boot would bump the mtime and force a needless re-extract each launch.
    let cur = null;
    try { cur = fs.readFileSync(dest); } catch { /* missing */ }
    if (!cur || !cur.equals(bytes)) fs.writeFileSync(dest, bytes);
  }
  return destDir;
}

module.exports = { isSea, materializeDeps, materializeLibexec };

'use strict';
// Node SEA helpers. All SEA behavior is gated on isSea(); everything is injectable
// (pass a `sea` object) so both branches unit-test without building a real SEA.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function seaMod() { try { return require('node:sea'); } catch { return null; } }
function isSea(sea = seaMod()) { return !!(sea && sea.isSea && sea.isSea()); }

// Raw bytes of an embedded asset as a Buffer. getRawAsset returns an ArrayBuffer
// for binary assets; Buffer.from wraps it without copying the backing store.
function assetBuffer(sea, name) { return Buffer.from(sea.getRawAsset(name)); }

// Unpack the embedded deps tarball to a persistent, sig-keyed cache dir; return the
// node_modules path to add to NODE_PATH. Idempotent: skips if already materialized.
// Atomic: extracts into a pid-tagged temp dir, then renames into place.
function materializeDeps({ sea = seaMod(), cacheDir }) {
  const sig = assetBuffer(sea, 'deps.sig').toString('utf8').trim();
  const dir = path.join(cacheDir, 'sea-deps', sig);
  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(nm)) return nm;                 // already materialized
  const tmp = dir + '.partial-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); // clear a stale partial from a crashed run
  fs.mkdirSync(tmp, { recursive: true });
  const tarPath = path.join(tmp, 'deps.tar');
  fs.writeFileSync(tarPath, assetBuffer(sea, 'deps.tar'));
  execFileSync('tar', ['-xf', tarPath, '-C', tmp]);  // extracts a node_modules/ dir
  fs.rmSync(tarPath);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);                            // atomic publish
  return nm;
}

// Write bun-shim.cjs (embedded asset) into destDir; return its path.
function materializeBunShim({ sea = seaMod(), destDir }) {
  const p = path.join(destDir, 'bun-shim.cjs');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(p, assetBuffer(sea, 'bun-shim.cjs'));
  return p;
}

module.exports = { isSea, materializeDeps, materializeBunShim };

'use strict';
// Node SEA helpers. All SEA behavior is gated on isSea(); everything is injectable
// (pass a `sea` object) so both branches unit-test without building a real SEA.
//
// Design note: rather than teach the shared launcher functions (extractIfNeeded,
// applyNodePath) about SEA, we materialize the embedded assets into ON-DISK layouts
// that mirror the npm/source tree — a depsRoot (whose node_modules holds the ext-deps)
// and a libexec (holding the named support assets). The rest of the launcher then runs
// UNCHANGED against those dirs, so SEA and source share one path.
const fs = require('node:fs');
const path = require('node:path');

function seaMod() { try { return require('node:sea'); } catch { return null; } }
// try/catch around the PROPERTY READS too, not just the require: a hostile
// or fail-loud module object (the node-shim's wallProxy for anything
// unshimmed) can throw on mere access — "am I a SEA?" must answer false,
// never crash, on every runtime (v0.1.2 field report).
function isSea(sea = seaMod()) {
  try { return !!(sea && sea.isSea && sea.isSea()); } catch { return false; }
}

// Raw bytes of an embedded asset as a Buffer. getRawAsset returns an ArrayBuffer
// for binary assets; Buffer.from wraps it without copying the backing store.
function assetBuffer(sea, name) { return Buffer.from(sea.getRawAsset(name)); }

// WHEN AN UNPACKED TREE IS WHOLE: its marker lists the package.json of every package it was
// unpacked with, and each one is still there -- not merely "node_modules/ exists". cacheDir
// defaults to os.tmpdir(), and macOS's periodic temp cleaner deletes files left there for days
// while leaving their directories: measured 2026-09-26, $TMPDIR/sea-deps/<sig>/node_modules still
// held its 21 package directories and not one file, and every naude using it died "ws ... isn't
// installed" at the bundle's first require('ws'), because the old check never unpacked again.
// Checking each package (one read and a stat per package, per launch) rather than the marker
// alone does not depend on which timestamp a cleaner ages files by, nor on it leaving the
// directories behind. A tree unpacked before the marker existed is not whole either: it is
// unpacked once more.
const UNPACKED = '.clode-unpacked.json';
function unpackedWhole(dir) {
  let listed;
  try { listed = JSON.parse(fs.readFileSync(path.join(dir, UNPACKED), 'utf8')); } catch { return false; }
  return Array.isArray(listed) && listed.every((p) => fs.existsSync(path.join(dir, p)));
}
// The package.json of every package directly under root/node_modules (scoped ones included).
function packageManifests(root) {
  const nm = path.join(root, 'node_modules');
  const out = [];
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const names = e.name.startsWith('@')
      ? fs.readdirSync(path.join(nm, e.name)).map((n) => `${e.name}/${n}`)
      : [e.name];
    for (const n of names) out.push(`node_modules/${n}/package.json`);
  }
  return out.filter((p) => fs.existsSync(path.join(root, p)));
}

// Unpack the embedded deps tarball to a persistent, sig-keyed cache dir and return
// that dir — shaped like a clode DEPS_ROOT (it contains node_modules/), so the caller
// hands it to the normal launch path as depsRoot with no SEA-specific handling.
// Idempotent (skips a tree that is whole, see UNPACKED) and atomic (temp dir + rename).
function materializeDeps({ sea = seaMod(), cacheDir, assetBuffer: getAsset = assetBuffer, spawn, env = process.env } = {}) {
  const { provision } = require('./host-provision.cjs');
  const { execFileSync } = require('node:child_process');
  const sig = getAsset(sea, 'deps.sig').toString('utf8').trim();
  const dir = path.join(cacheDir, 'sea-deps', sig);
  if (unpackedWhole(dir)) return dir;   // already materialized
  const tmp = dir + '.partial-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); // clear a stale partial from a crashed run
  fs.mkdirSync(tmp, { recursive: true });
  // Extract via STDIN (`-xf -`) with tmp as the process cwd, instead of passing OS-native paths
  // as tar args. On Windows under a bash PATH, `tar` is Git Bash's GNU tar, which reads an archive
  // path like `C:\…\deps.tar` as a remote `host:path` (the drive-letter colon) and dies "Cannot
  // connect". Streaming the buffer to stdin with no colon-bearing path args is uniform on GNU tar
  // (Windows/Linux) and bsdtar (macOS) — the runtime mirror of the build-side archive step. Which
  // tar binary that is comes from provision('tar') (host-provision.cjs), the SAME KAT-verified
  // resolver the builder uses — not a bare 'tar' literal, so a tar-less PATH fails loud with an
  // install hint instead of a raw ENOENT.
  const { path: tarBin } = provision('tar', { env, spawn });
  const runExtract = spawn
    ? (bin, args) => spawn(bin, args, { cwd: tmp, input: getAsset(sea, 'deps.tar'), maxBuffer: 1 << 30 })
    : (bin, args) => execFileSync(bin, args, { cwd: tmp, input: getAsset(sea, 'deps.tar'), maxBuffer: 1 << 30 });
  runExtract(tarBin, ['-xf', '-']);
  fs.writeFileSync(path.join(tmp, UNPACKED), JSON.stringify(packageManifests(tmp)));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A tree that is there but not whole (emptied by the cleaner, or unpacked before the marker)
  // is moved aside first: the rename below cannot land on a non-empty directory. Re-checked
  // here, so a tree another launch published whole meanwhile is left alone.
  if (fs.existsSync(dir) && !unpackedWhole(dir)) {
    const stale = dir + '.stale-' + process.pid;
    try { fs.renameSync(dir, stale); fs.rmSync(stale, { recursive: true, force: true }); } catch { /* another launch moved it first */ }
  }
  try {
    fs.renameSync(tmp, dir);                          // atomic publish
  } catch (e) {
    // Lost a cold-start race: another clode published this sig first. Its dir is
    // authoritative (rename onto a non-empty dir fails ENOTEMPTY/EEXIST) — drop ours.
    if (unpackedWhole(dir)) fs.rmSync(tmp, { recursive: true, force: true });
    else throw e;
  }
  return dir;
}

// Write the named embedded assets into destDir and return it. Handed to
// extractIfNeeded as `libexec`, so its unchanged logic finds the shim
// (libexec/bun-shim.cjs) and fingerprints the extractor exactly as in the
// npm/source layout. The asset list is parameterized (`names`) so callers pick
// what to materialize — e.g. naude uses ['cli.cjs', 'bun-shim.cjs'].
function materializeAssets({ sea = seaMod(), destDir, names }) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const dest = path.join(destDir, name);
    const bytes = assetBuffer(sea, name);
    // Write only when missing or changed, so an unchanged asset keeps its mtime.
    // extractIfNeeded fingerprints the extractor via sigOf (size-mtime); rewriting it
    // every boot would bump the mtime and force a needless re-extract each launch.
    let cur = null;
    try { cur = fs.readFileSync(dest); } catch { /* missing */ }
    if (!cur || !cur.equals(bytes)) fs.writeFileSync(dest, bytes);
  }
  return destDir;
}

module.exports = { seaMod, isSea, materializeDeps, materializeAssets };

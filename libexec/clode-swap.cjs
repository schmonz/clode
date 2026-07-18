'use strict';
// Replace the bytes at `target` with the freshly-built `temp`. BOTH must already
// be in the SAME directory — the caller builds the temp in the target's own dir
// so this rename never crosses filesystems (EXDEV). Throws with the target LEFT
// UNCHANGED on any failure — a half-done swap is worse than no update. Seams
// injected for tests.
const fs = require('node:fs');
const path = require('node:path');

function swapInPlace(temp, target, opts = {}) {
  const platform = opts.platform || process.platform;
  const rename = opts.rename || fs.renameSync;
  const rm = opts.rm || ((p) => fs.rmSync(p, { force: true }));

  if (path.dirname(path.resolve(temp)) !== path.dirname(path.resolve(target))) {
    throw new Error(
      `clode-swap: temp and target must be in the same directory (rename cannot cross `
      + `filesystems / EXDEV): ${temp} vs ${target}`);
  }

  if (platform === 'win32') {
    // A running .exe is mapped: it cannot be renamed OVER, but it CAN be renamed
    // ASIDE. Move it aside, drop the new one in, best-effort delete the aside copy
    // (fails while the old process still runs — leave it; a later clode run sweeps
    // stale `.old-*`). If dropping the new one in fails, restore the original name
    // so the target is unchanged.
    const token = opts.randToken;
    if (!token) throw new Error('clode-swap: win32 swap needs a randToken');
    const old = `${target}.old-${token}`;
    rename(target, old);
    try {
      rename(temp, target);
    } catch (e) {
      try { rename(old, target); } catch { /* best effort restore */ }
      throw e;
    }
    try { rm(old); } catch { /* still-running: sweep later */ }
    return;
  }

  // POSIX: one atomic rename. The path is never missing; the running process keeps
  // its old inode until it exits, and the next launch gets the new binary.
  rename(temp, target);
}

module.exports = { swapInPlace };

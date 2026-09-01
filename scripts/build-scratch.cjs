'use strict';
// build-scratch — the ONE place a build path comes from.
//
// Why this exists: the good defaults already existed (the txiki vendor moved to
// ~/.cache/clode, cmake intermediates to TMPDIR, every fuse scratch dir to an
// os.tmpdir() mkdtemp) and CI overrode them straight back into the checkout —
// see .github/actions/build-leg/action.yml, which pointed CLODE_TJS_VENDOR and
// CLODE_TJS_OUT at "$PWD/.matrix/...". A default protects only whoever does not
// touch it. This module makes the in-tree path unrepresentable instead.
//
// Pure node stdlib; fs/env/spawn injected for testability.
const realFs = require('node:fs');
const path = require('node:path');

class BuildScratchError extends Error {
  constructor(msg) { super(msg); this.name = 'BuildScratchError'; this.code = 'CLODE_BUILD_SCRATCH'; }
}

// The marker is deliberately a CONJUNCTION. Any single file would misfire: plenty
// of projects have a VERSION or a package.json, and keying on .git would refuse to
// build inside ANY repo — including a user's, which must keep working.
function isCheckoutRoot(dir, fsm = realFs) {
  try {
    if (!fsm.existsSync(path.join(dir, 'libexec', 'clode-fuse.cjs'))) return false;
    if (!fsm.existsSync(path.join(dir, 'VERSION'))) return false;
    const pkg = JSON.parse(fsm.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'clode';
  } catch { return false; }
}

function findCheckoutRoot(startPath, fsm = realFs) {
  let dir;
  try { dir = fsm.realpathSync(startPath); }
  catch { dir = path.resolve(startPath); }   // may not exist yet: a path we are ABOUT to create
  for (;;) {
    if (isCheckoutRoot(dir, fsm)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function isInsideCheckout(p, fsm = realFs) { return findCheckoutRoot(p, fsm) !== null; }

module.exports = { BuildScratchError, isCheckoutRoot, findCheckoutRoot, isInsideCheckout };

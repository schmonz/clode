'use strict';
// clode-current — the SINGLE SEAM for clode's active-provider pointer
// (<providers>/current). All symlink/pointer representation knowledge lives HERE so
// the on-disk form can change in one place. Pure Node stdlib; env + fsm injected for
// testability. Consumed by clode-resolve (step 3 provider `current`), clode-update
// (prev-version + re-point), and clode-watch (current version). Must NOT require
// clode-resolve (resolve requires this — that would cycle).
//
// Phase A: `current` is a relative SYMLINK to <ver> (today's behavior). A later task
// flips these three functions to a pointer FILE without touching any caller.
const fs = require('node:fs');
const path = require('node:path');
const { providersDir } = require('./clode-paths.cjs');

function currentPath(env) {
  return path.join(providersDir(env), 'current');
}

// The version string <providers>/current points at, or '' if there is none.
function currentVersion(env, fsm = fs) {
  const cur = currentPath(env);
  try {
    if (fsm.lstatSync(cur).isSymbolicLink()) return fsm.readlinkSync(cur);
  } catch { /* none */ }
  return '';
}

// Absolute path to the current provider's `claude` binary, or null. Mirrors the old
// resolve step 3: realpath-resolve the `current` symlink dir + '/claude', iff that
// file exists.
function currentBin(env, fsm = fs) {
  const cur = currentPath(env);
  try { fsm.statSync(`${cur}/claude`); } catch { return null; }
  let physDir;
  try { physDir = fsm.realpathSync(cur); } catch { physDir = ''; }
  return `${physDir}/claude`;
}

// Point <providers>/current at `ver`, replacing any prior entry (ln -sfn semantics):
// remove any existing file/dir/symlink, then create a RELATIVE symlink to `ver`.
function setCurrent(env, ver, fsm = fs) {
  const cur = currentPath(env);
  try { fsm.lstatSync(cur); fsm.rmSync(cur, { recursive: true, force: true }); } catch { /* absent */ }
  fsm.symlinkSync(ver, cur);
}

module.exports = { currentVersion, currentBin, setCurrent, currentPath };

'use strict';
// clode-current — the SINGLE SEAM for clode's active-provider pointer
// (<providers>/current). All symlink/pointer representation knowledge lives HERE so
// the on-disk form can change in one place. Pure Node stdlib; env + fsm injected for
// testability. Consumed by clode-resolve (step 3 provider `current`), clode-update
// (prev-version + re-point), and clode-watch (current version). Must NOT require
// clode-resolve (resolve requires this — that would cycle).
//
// `current` is a pointer FILE containing the version string (trimmed). Uniform on
// every platform; no privilege needed on Windows. A legacy symlink-to-dir self-heals:
// currentVersion sees EISDIR and returns '', and the next setCurrent removes it.
const fs = require('node:fs');
const path = require('node:path');
const { providersDir } = require('./clode-paths.cjs');

function currentPath(env) {
  return path.join(providersDir(env), 'current');
}

// The version string <providers>/current points at, or '' if there is none.
// Pointer file: the file's trimmed contents. A legacy symlink-to-dir reads as EISDIR
// -> '' (ignored; the next setCurrent rewrites it as a file).
function currentVersion(env, fsm = fs) {
  try { return fsm.readFileSync(currentPath(env), 'utf8').trim(); } catch { return ''; }
}

// Absolute path to the current provider's `claude` binary, or null. Reads the pointer
// version, then <providers>/<ver>/claude iff it exists. The path still contains
// /providers/<ver>/, so cacheKey keys off <ver> (shared-per-version cache preserved).
function currentBin(env, fsm = fs) {
  const ver = currentVersion(env, fsm);
  if (!ver) return null;
  const bin = path.join(providersDir(env), ver, 'claude');
  try { fsm.statSync(bin); } catch { return null; }
  return bin;
}

// Point <providers>/current at `ver`: write a pointer FILE atomically (temp + rename),
// removing any prior entry first (incl. a legacy symlink/dir). No symlink -> no
// privilege needed on Windows.
function setCurrent(env, ver, fsm = fs) {
  const cur = currentPath(env);
  const tmp = `${cur}.${process.pid}.tmp`;
  fsm.writeFileSync(tmp, `${ver}\n`);
  try { fsm.rmSync(cur, { recursive: true, force: true }); } catch { /* absent */ }
  fsm.renameSync(tmp, cur);
}

module.exports = { currentVersion, currentBin, setCurrent, currentPath };

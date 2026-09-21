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
const cpaths = require('./clode-paths.cjs');
const { providersDir } = cpaths;

function currentPath(env) {
  return path.join(providersDir(env), 'current');
}

// The version string <providers>/current points at, or '' if there is none.
// Pointer file: the file's trimmed contents. A legacy symlink-to-dir reads as EISDIR
// -> '' (ignored; the next setCurrent rewrites it as a file).
function currentVersion(env, fsm = fs) {
  try { return fsm.readFileSync(currentPath(env), 'utf8').trim(); } catch { return ''; }
}

// RE-KEY A LEGACY VERSION-ONLY ENTRY, from what its own bytes say it is.
//
// The store was `providers/<ver>/claude` — one binary per version, while `clode fetch claude` is
// OS-matched, so the same path meant different bytes on different machines (see
// clode-paths.cjs's PROVIDER STORE LAYOUT comment for the full account and the measured
// consequence). Every existing store on every existing box holds entries in that layout,
// and the requirement for them is precise: an existing user's first run after this change
// must not silently use the wrong binary.
//
// Three options were on the table. RE-FETCH (ignore them) is safe but throws away a ~250MB
// download that is usually CORRECT. DELETE is worse — they are the user's bytes. So:
// RE-KEY IN PLACE, from the container header, which is the same question the build's carve
// gate already asks of a provider (providerPlatformOf) plus the arch dimension from the same
// header (providerArchOf). A rename inside one directory, no network, no re-verify.
//
// An entry whose container we cannot identify gets NO key: inventing one is precisely how
// the wrong binary gets served, which is the defect. It is left exactly where it is, where
// nothing resolves it — and it is not deleted either.
//
// Triggered on READ (currentBin) as well as on fetch, because the first run after an upgrade
// is a read. Best-effort and fail-CLOSED: if the rename cannot happen (read-only store,
// permissions), the legacy path is still not served. Idempotent — after one pass there is no
// legacy file left to see, so the cost on every later run is one failed statSync.
function rekeyLegacyEntry(env, version, fsm = fs) {
  const legacy = path.join(providersDir(env), version, 'claude');
  try { if (!fsm.statSync(legacy).isFile()) return; } catch { return; }   // nothing to do
  let plat, arch;
  try {
    const { providerPlatformOf, providerArchOf } = require('./extract-claude-js.cjs');
    plat = providerPlatformOf(legacy);
    arch = providerArchOf(legacy);
  } catch { return; }
  if (!plat || !arch) return;             // unidentifiable: decline to guess a key
  const dest = cpaths.providerBinPath(env, version, cpaths.providerKey(plat, arch));
  try {
    fsm.mkdirSync(path.dirname(dest), { recursive: true });
    fsm.renameSync(legacy, dest);
  } catch { /* fail closed: the legacy path is not served either way */ }
}

// Absolute path to the current provider's `claude` binary, or null.
//
// Reads the pointer version, re-keys any legacy version-only entry for it, then picks the
// entry this HOST may use out of the keys present (cpaths.pickProviderEntry: exact
// `<os>-<arch>`, else same-OS, NEVER another OS). The path still contains /providers/<ver>/
// as its first segment, so clode-resolve's cacheKey keys off <ver> exactly as before and the
// shared-per-version extraction cache is preserved — that cache tells carves apart by
// SIGNATURE (clode-extract's cacheSignature carries providerPlatform), not by key.
function currentBin(env, fsm = fs) {
  const ver = currentVersion(env, fsm);
  if (!ver) return null;
  rekeyLegacyEntry(env, ver, fsm);
  let keys;
  try {
    keys = fsm.readdirSync(cpaths.providerVersionDir(env, ver), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return null; }
  const key = cpaths.pickProviderEntry(keys);
  if (!key) return null;
  const bin = cpaths.providerBinPath(env, ver, key);
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

module.exports = { currentVersion, currentBin, setCurrent, currentPath, rekeyLegacyEntry };

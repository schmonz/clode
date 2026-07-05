'use strict';
// clode-resolve — JS port of bin/clode's upstream-binary resolution + cache-key
// logic. Pure Node stdlib (runs before any ext-deps are ensured). Behavior-for-
// behavior with the sh launcher's resolve_claude_bin, follow_wrapper, sig_of and
// cache_key. Every function is unit-testable without a real HOME/provider store:
// env, fs, and the baked provider path are all injectable.

const fs = require('node:fs');
const path = require('node:path');
const { homeDir } = require('./clode-paths.cjs');
const { currentBin } = require('./clode-current.cjs');

// Does `p` exist? Mirrors sh `[ -e "$p" ]` — existence, following symlinks (any
// stat error, incl. a dangling link, is "no"). statSync (not lstat) so a symlink
// to a live target counts as existing, matching -e.
function pathExists(p, fsm = fs) {
  try {
    fsm.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Fast size+mtime signature. Mirrors sig_of, whose canonical form is the node
// fallback: "<size>-<Math.trunc(mtimeMs/1000)>" (GNU `%s-%Y` / BSD `%z-%m` yield
// the same integers). Throws (like statSync) if the file is gone — sig_of only
// runs on a path already resolved to exist.
function sigOf(p, fsm = fs) {
  const s = fsm.statSync(p);
  return `${s.size}-${Math.trunc(s.mtimeMs / 1000)}`;
}

// Cache key. Mirrors cache_key: a path that encodes a version
// (.../versions/<ver>[/...] or .../providers/<ver>[/...]) keys off <ver> so all
// hosts share one cache entry per upstream version; otherwise <basename>-<sig> so
// a changed provider binary re-extracts.
//   sh: KEY=${BIN#*/versions/}; KEY=${KEY%%/*}   (segment after the FIRST match)
function cacheKey(bin, fsm = fs) {
  const norm = bin.replace(/\\/g, '/'); // Windows paths use '\'; match markers on either separator
  for (const marker of ['/versions/', '/providers/']) {
    const i = norm.indexOf(marker); // #*/versions/ removes up to the FIRST occurrence
    if (i !== -1) {
      return norm.slice(i + marker.length).split('/')[0]; // %%/* -> up to the first slash
    }
  }
  return `${path.basename(bin)}-${sigOf(bin, fsm)}`;
}

// Follow a tiny sh exec-wrapper to the real single-file bundle. Mirrors
// follow_wrapper: bounded to 10 hops; only inspects files small enough to BE a
// wrapper (< 65536 bytes) so the >100MB bundle passes straight through; follows
// only an ABSOLUTE exec target (a `exec "$@"` / `exec env ...` / relative line
// leaves the path unchanged); stops when the target is missing or would self-loop.
function followWrapper(startPath, fsm = fs) {
  let w = startPath;
  let n = 0;
  while (n < 10) {
    let st;
    try {
      st = fsm.statSync(w);
    } catch {
      break; // sh loop guard: `[ -f "$_w" ]`
    }
    if (!st.isFile()) break; // -f is a regular file
    // wc -c < file, guarded to 999999 on error -> effectively "too big, stop".
    if (st.size >= 65536) break;
    let content;
    try {
      // latin1 so arbitrary bytes round-trip; we only match ASCII on line starts.
      content = fsm.readFileSync(w, 'latin1');
    } catch {
      break;
    }
    // sed -n 's/^[[:space:]]*exec[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | tail -1
    // -> the first non-space token after `exec` on the LAST matching line.
    let target = null;
    for (const line of content.split('\n')) {
      const m = line.match(/^[ \t\f\v\r]*exec[ \t\f\v\r]+([^ \t\f\v\r]+)/);
      if (m) target = m[1];
    }
    if (target === null) break;
    if (!path.win32.isAbsolute(target)) break; // absolute only (win32.isAbsolute: also /x, uniformly on every host)
    if (!pathExists(target, fsm) || target === w) break; // -e "$_t" && "$_t" != "$_w"
    w = target;
    n += 1;
  }
  return w;
}

// Resolve the upstream claude binary to extract from. Mirrors resolve_claude_bin,
// precedence:
//   CLODE_CLAUDE_BIN > CLODE_VERSION_DIR > provider `current`
//   > baked CLAUDE_BIN_BAKED > ~/.local/bin/claude (readlink-resolved) > `claude` on PATH
// Returns the resolved path, or null for the sh `return 1` (not-found) signal.
// env / fs / the baked path are injectable so this is testable without a real HOME.
function resolveClaudeBin(opts = {}) {
  const { env = process.env, fsm = fs, baked = '' } = opts;

  // 1. explicit binary override — returned verbatim, existence checked by caller.
  if (env.CLODE_CLAUDE_BIN) return env.CLODE_CLAUDE_BIN;
  // 2. explicit version dir — likewise verbatim.
  if (env.CLODE_VERSION_DIR) return env.CLODE_VERSION_DIR;

  // 3. clode-managed provider `current` — the active version's claude, if any
  //    (resolved through the clode-current seam: a pointer file -> providers/<ver>/claude).
  const cbin = currentBin(env, fsm);
  if (cbin) return cbin;

  // 4. baked provider path (empty in the JS default; kept for parity).
  if (baked && pathExists(baked, fsm)) return baked;

  const home = homeDir(env);

  // 5. ~/.local/bin/claude[.exe], single-hop readlink-resolved (relative -> anchored
  //    at the link's dir). The native installer writes `claude` on POSIX (a symlink
  //    into versions/<ver>) and `claude.exe` on Windows (a plain copy — symlinks need
  //    privilege there). Try both leaf names uniformly; `claude.exe` never exists on
  //    POSIX, so the list is a no-op there (no platform branch). `claude` is tried
  //    first so a POSIX install's version-keyed symlink is preferred if both exist.
  for (const leaf of ['claude', 'claude.exe']) {
    const link = path.join(home, '.local', 'bin', leaf); // native separators (Windows: backslashes)
    if (!pathExists(link, fsm)) continue;
    let real;
    try {
      real = fsm.readlinkSync(link);
    } catch {
      real = link; // not a symlink (e.g. the Windows copy) -> the path itself
    }
    // Anchor a RELATIVE readlink target at the link dir; use an absolute one as-is.
    // path.win32.isAbsolute (not a leading-'/' test) so a Windows drive path (C:\...)
    // from the plain-copy case is returned unmangled.
    if (!path.win32.isAbsolute(real)) real = path.join(path.dirname(link), real);
    return real;
  }

  // 6. `claude` on PATH (command -v: first executable named claude).
  const found = whichClaude(env, fsm);
  if (found) return found;

  // sh `return 1` — not found.
  return null;
}

// command -v claude: first executable regular file named `claude` on PATH.
function whichClaude(env, fsm = fs) {
  const PATH = env.PATH || '';
  // Candidate leaf names: `claude` plus the Windows executable extensions from PATHEXT (data, not a
  // platform branch — on POSIX PATHEXT is unset so the default list's `.exe`/`.cmd`/… simply never
  // exist; on Windows a PATH provider is claude.exe/claude.cmd).
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const leaves = ['claude', ...exts.map((e) => 'claude' + e)];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue; // an empty PATH element means CWD in sh; clode never relies on it
    for (const leaf of leaves) {
      const cand = path.join(dir, leaf);
      try {
        if (!fsm.statSync(cand).isFile()) continue;
        fsm.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch {
        // not there / not executable -> keep walking
      }
    }
  }
  return null;
}

module.exports = {
  resolveClaudeBin,
  followWrapper,
  sigOf,
  cacheKey,
  // exported for completeness / reuse; not part of the required API surface
  pathExists,
  whichClaude,
};

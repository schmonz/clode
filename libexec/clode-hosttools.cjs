'use strict';
// clode-hosttools — JS port of bin/clode's host-tool discovery. Pure Node
// stdlib. Behavior-for-behavior with the sh launcher's `command -v` lookups.
// (The bundle-env setup this module used to also carry — maybe_default_cert_store,
// set_ripgrep_env, set_node_path — moved to target-env.cjs, applied by the built
// targets themselves; clode never runs the bundle, so it no longer needs them.
// The node-floor enforcement this module also used to carry — checkNodeVersion,
// requireNodeVersionOrExit, MIN_NODE_MAJOR=24 — was the retired runner's job,
// gating the bundle it ran under node; clode's OWN floor is bin/clode's inlined
// ES5-safe v20 check, which never needed this module. Deleted rather than kept
// on the false premise of "other callers" — there were none.) Every function is
// unit-testable without a real launch: PATH, executability, stderr, and exit are
// all injectable.

const fs = require('node:fs');
const path = require('node:path');

// Is `p` an executable regular file? (sh `command -v`/`[ -x ]` accept a path only
// when it resolves to something runnable.) Any error (missing, EACCES, a dir) is
// a plain "not executable".
//
// WIN32 DOES NOT ASK X_OK, and that is not a tidy-up — it is the difference between
// finding the host's tools and reporting that Windows ships none. Under quaude/tjs
// `fs.accessSync` is __tjs_fs_sync.access -> the CRT's `_access`, which validates its
// mode as `(mode & ~6) == 0` and therefore rejects X_OK (1) with EINVAL for EVERY
// path, existing or not. Under Node/libuv the identical call is a no-op that succeeds
// (fs__access only consults FILE_ATTRIBUTE_READONLY, and only for W_OK). So this
// predicate answered "no" for every candidate on the SHIPPED Windows binary while
// answering "yes" under Node — invisible to every Node-side test.
//
// libexec/bun-shim.cjs:825-843 had already worked this out for its own `which` and
// marked it "UNVERIFIED ON WINDOWS". CI run 33245690046 verified it: windows-amd64 and
// windows-arm64 both reported `[tried: zstd: not found; unzstd: not found; zstdcat: not
// found]` from the fused builder, in a job where actions/cache had just run
// `tar --use-compress-program "zstd -d"` — the tool was there; this function could not
// see it. (It surfaced only when the zstd decoder started resolving through findTool;
// the same blindness was already costing provision('sha256'|'tar') on Windows.)
//
// There is no execute bit on Windows to ask about, and PATHEXT probing in findTool is
// what makes the NAME mean "executable", so a regular-file check is the honest question.
// POSIX is unchanged, byte for byte. `fs`/`isWin` are injectable so this is testable
// from any host — the same seam findTool already offers.
function isExecutableFile(p, opts = {}) {
  const { fs: fsm = fs, isWin = process.platform === 'win32' } = opts;
  try {
    if (!fsm.statSync(p).isFile()) return false;
    if (isWin) return true;
    fsm.accessSync(p, fsm.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Replacement for `command -v NAME` with the CLODE_* override pattern
// (`${OVERRIDE:-$(command -v NAME)}`): return the override if it is set and
// executable, else walk PATH for an executable `name`, else null.
// On Windows a bare tool name resolves to name+PATHEXT (certutil -> certutil.exe,
// tar -> tar.exe); without probing PATHEXT the walk finds nothing and provision
// wrongly reports "no tool found" for tools that ship WITH Windows. Mirrors
// child_process.cjs's resolveExe. isWin is injectable for host-independent tests.
function findTool(name, opts = {}) {
  const {
    override, env = process.env, fs: fsm = fs,
    isWin = process.platform === 'win32',
    // The default predicate inherits THIS call's isWin/fs, so injecting either one
    // steers the whole lookup — otherwise a test could set isWin:true and still be
    // answered by the host's own platform.
    isExec = (p) => isExecutableFile(p, { fs: fsm, isWin }),
  } = opts;
  if (override && isExec(override)) return override;
  const delim = isWin ? ';' : ':';
  const hasExt = isWin && /\.[^.\\/]+$/.test(name); // e.g. an explicit "tar.exe"
  const exts = isWin && !hasExt
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (env.PATH || '').split(delim)) {
    if (!dir) continue; // an empty PATH element means CWD in sh; clode never relies on it
    for (const ext of exts) {
      const cand = path.join(dir, name + ext);
      if (isExec(cand)) return cand;
    }
  }
  return null;
}

module.exports = {
  isExecutableFile,
  findTool,
};

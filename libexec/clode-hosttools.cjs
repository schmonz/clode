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
function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
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
    override, env = process.env, isExec = isExecutableFile,
    isWin = process.platform === 'win32',
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

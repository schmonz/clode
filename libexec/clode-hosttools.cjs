'use strict';
// clode-hosttools — JS port of bin/clode's host-tool discovery + node-floor
// enforcement. Pure Node stdlib. Behavior-for-behavior with the sh launcher's
// `command -v` lookups and require_node. (The bundle-env setup this module used to
// also carry — maybe_default_cert_store, set_ripgrep_env, set_node_path — moved to
// target-env.cjs, applied by the built targets themselves; clode never runs the
// bundle, so it no longer needs them.) Every function is unit-testable without a
// real launch: PATH, executability, stderr, and exit are all injectable.

const fs = require('node:fs');
const path = require('node:path');

// Minimum Node major. The extracted bundle adopts newer JS over time (today TC39
// `using`, needs Node >= 24); this creeps upward. Mirrors MIN_NODE_MAJOR in
// bin/clode's require_node.
const MIN_NODE_MAJOR = 24;

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
function findTool(name, opts = {}) {
  const { override, env = process.env, isExec = isExecutableFile } = opts;
  if (override && isExec(override)) return override;
  const PATH = env.PATH || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue; // an empty PATH element means CWD in sh; clode never relies on it
    const cand = path.join(dir, name);
    if (isExec(cand)) return cand;
  }
  return null;
}

// The launcher IS node, so the running version is authoritative (no subprocess,
// unlike the sh which shells out to `"$NODE" -e ...`). Returns {ok, major}; the
// caller decides whether to print/exit (see requireNodeVersionOrExit).
function checkNodeVersion(versionString = process.versions.node) {
  const major = parseInt(String(versionString).split('.')[0], 10) || 0;
  return { ok: major >= MIN_NODE_MAJOR, major };
}

// Port of require_node's error surface. Prints the EXACT sh messages and exits 1.
// - `nodePath` set + not executable -> "no usable node at '<path>' (set CLODE_NODE)"
// - version below the floor -> the two-line "too old" + "using declarations" note
// Returns {ok, major} when node is fine. stderr/exit/isExec are injectable so this
// is testable without terminating the test process.
function requireNodeVersionOrExit(opts = {}) {
  const {
    versionString = process.versions.node,
    nodePath,
    isExec = isExecutableFile,
    stderr = process.stderr,
    exit = process.exit,
  } = opts;
  if (nodePath != null && !isExec(nodePath)) {
    stderr.write(`clode: no usable node at '${nodePath}' (set CLODE_NODE)\n`);
    return exit(1);
  }
  const res = checkNodeVersion(versionString);
  if (!res.ok) {
    // sh prints `node --version` output, which is always "vX.Y.Z".
    const disp = String(versionString).startsWith('v') ? versionString : `v${versionString}`;
    stderr.write(`clode: node ${disp} is too old; need >= v${MIN_NODE_MAJOR}\n`);
    stderr.write("clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
    return exit(1);
  }
  return res;
}

module.exports = {
  MIN_NODE_MAJOR,
  isExecutableFile,
  findTool,
  checkNodeVersion,
  requireNodeVersionOrExit,
};

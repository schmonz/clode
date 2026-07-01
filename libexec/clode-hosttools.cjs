'use strict';
// clode-hosttools — JS port of bin/clode's host-tool discovery + host-environment
// setup. Pure Node stdlib (runs before any ext-deps are ensured). Behavior-for-
// behavior with the sh launcher's `command -v` lookups, require_node,
// maybe_default_cert_store, set_ripgrep_env, and set_node_path. Every function is
// unit-testable without a real launch: PATH, trustd presence, the rg location, the
// dep dirs, executability, stderr, and exit are all injectable.

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

// Port of maybe_default_cert_store. On legacy macOS (no trustd; the old ocspd/CSSM
// trust stack) default CLAUDE_CODE_CERT_STORE=bundled to avoid blocking per-cert
// OCSP fetches that stall the TUI. Respects a user-set value; no-op on modern macOS
// (trustd present) and off macOS entirely. `trustdPath` mirrors the CLODE_TRUSTD
// probe override. Mutates and returns env.
function certStoreDefault(opts = {}) {
  const {
    platform = process.platform,
    env = process.env,
    trustdPath = env.CLODE_TRUSTD || '/usr/libexec/trustd',
    exists = fs.existsSync,
  } = opts;
  if (platform !== 'darwin') return env;
  if (exists(trustdPath)) return env; // modern trust stack: leave the app default
  // sh `: "${VAR:=bundled}"` sets when unset OR empty.
  if (env.CLAUDE_CODE_CERT_STORE == null || env.CLAUDE_CODE_CERT_STORE === '') {
    env.CLAUDE_CODE_CERT_STORE = 'bundled';
  }
  return env;
}

// Port of set_ripgrep_env. Point Claude Code's Grep tool at a real ripgrep when one
// exists: force system mode (USE_BUILTIN_RIPGREP=0, unless the user set it) and make
// the chosen rg discoverable by prepending its dir to PATH (the bundle resolves `rg`
// by name). rg stays OPTIONAL — no rg found means leave the config untouched. The
// CLODE_RG override (passed as `override`) wins verbatim, matching the sh
// `${CLODE_RG:-$(command -v rg)}`. Mutates and returns env.
function applyRipgrepEnv(opts = {}) {
  const { env = process.env, isExec = isExecutableFile } = opts;
  const override = 'override' in opts ? opts.override : env.CLODE_RG;
  const rg = override ? override : findTool('rg', { env, isExec });
  if (!rg) return env; // no rg -> leave config alone (embedded search)
  if (env.USE_BUILTIN_RIPGREP == null || env.USE_BUILTIN_RIPGREP === '') {
    env.USE_BUILTIN_RIPGREP = '0';
  }
  const rgdir = path.dirname(rg);
  const cur = env.PATH || '';
  // sh: `case ":$PATH:" in *":$_rgdir:"*)` — whole-segment membership test.
  if (!cur.split(path.delimiter).includes(rgdir)) {
    env.PATH = `${rgdir}${path.delimiter}${cur}`; // sh: PATH="$_rgdir:$PATH"
  }
  return env;
}

// Port of set_node_path. Make clode's runtime deps resolvable by the shim (which
// runs from the cache dir). Appends each existing dep node_modules dir to NODE_PATH,
// most-authoritative first, preserving any NODE_PATH the user set (theirs stays
// ahead). Dirs, in sh order:
//   1. clode's own node_modules  ($HERE/../node_modules — the npm-install layout)
//   2. $DEPS_ROOT/node_modules   (where ensure_deps installs)
//   3. <node-prefix>/lib/node_modules  (global installs)
// Callers may pass a pre-resolved `dirs` array (tests do); otherwise pass
// `here`/`depsRoot`/`node` and the same three candidates are derived. Only existing
// directories are added, and never twice. Mutates and returns env.
function applyNodePath(opts = {}) {
  const {
    env = process.env,
    here,
    depsRoot,
    node,
    isDir = (p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    },
  } = opts;
  let dirs = opts.dirs;
  if (!dirs) {
    dirs = [];
    // Under a SEA the ext-deps come from a materialized node_modules (a full path,
    // not a depsRoot); it's the most authoritative, so it leads the clode-derived set.
    if (opts.extraDir) dirs.push(opts.extraDir);
    if (here) dirs.push(path.join(path.resolve(here, '..'), 'node_modules'));
    if (depsRoot) dirs.push(path.join(depsRoot, 'node_modules'));
    if (node) dirs.push(path.join(path.dirname(node), '..', 'lib', 'node_modules'));
  }
  for (const d of dirs) {
    if (!d || !isDir(d)) continue;
    const cur = env.NODE_PATH || '';
    const parts = cur ? cur.split(path.delimiter) : [];
    if (parts.includes(d)) continue; // sh: `case ":$NODE_PATH:" in *":$_d:"*)`
    env.NODE_PATH = cur ? `${cur}${path.delimiter}${d}` : d; // sh: "${NODE_PATH:+$NODE_PATH:}$_d"
  }
  return env;
}

module.exports = {
  MIN_NODE_MAJOR,
  isExecutableFile,
  findTool,
  checkNodeVersion,
  requireNodeVersionOrExit,
  certStoreDefault,
  applyRipgrepEnv,
  applyNodePath,
};

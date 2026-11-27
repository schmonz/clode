'use strict';
// clode-hosttools — JS port of bin/clode's host-tool discovery. Pure Node
// stdlib. Behavior-for-behavior with the sh launcher's `command -v` lookups.
// (The bundle-env setup this module used to also carry — maybe_default_cert_store,
// set_ripgrep_env, set_node_path — moved to target-env.cjs, applied by the built
// targets themselves; clode never runs the bundle, so it no longer needs them.
// The node-floor enforcement this module also used to carry — checkNodeVersion,
// requireNodeVersionOrExit, MIN_NODE_MAJOR=24 — was the retired runner's job,
// gating the bundle it ran under node; clode's OWN floor is scripts/stage0.mjs's
// inlined ES5-safe v20 check, which never needed this module. Deleted rather than kept
// on the false premise of "other callers" — there were none.) Every function is
// unit-testable without a real launch: PATH, executability, stderr, and exit are
// all injectable.

const fs = require('node:fs');

const { isExecutableFile: sharedIsExecutableFile, lookPath } = require('./path-lookup.cjs');

// Is `p` an executable regular file? path-lookup.cjs's predicate (a regular file; X_OK off Windows only), with this
// module's injectable seams: `fs`, and `isWin` so a test steers it from any host.
//
// WIN32 DOES NOT ASK X_OK, and that is not a tidy-up — it is the difference between finding the host's tools and
// reporting that Windows ships none. Under quaude/tjs `fs.accessSync` is __tjs_fs_sync.access -> the CRT's `_access`,
// which validates its mode as `(mode & ~6) == 0` and therefore rejects X_OK (1) with EINVAL for EVERY path. CI run
// 33245690046 verified it: windows-amd64 and windows-arm64 both reported `zstd: not found` from the blobulated builder,
// in a job where actions/cache had just run `zstd -d`. path-lookup.cjs states the rule once; this keeps the seam.
function isExecutableFile(p, opts = {}) {
  const { fs: fsm = fs, isWin = process.platform === 'win32' } = opts;
  return sharedIsExecutableFile(p, { fs: fsm, isWin });
}

// Replacement for `command -v NAME` with the CLODE_* override pattern
// (`${OVERRIDE:-$(command -v NAME)}`): return the override if it is set and
// executable, else path-lookup.cjs's PATH search for an executable `name`, else null.
// isWin/fs/isExec are injectable for host-independent tests.
//
// Two named divergences from node's own search (path-lookup.cjs's options), both win32-only:
//   pathext: true      — provision() asks "which tool does this host have", and on Windows a tool may be a .cmd/.bat
//                        (npm is npm.cmd); libuv's .com/.exe alone would report it missing.
//   windowsCwd: false  — clode runs what this finds; a tar.exe in whatever directory the user stands in must not
//                        shadow the system's.
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
  return lookPath(name, { env, platform: isWin ? 'win32' : 'posix', pathext: true, windowsCwd: false, isExec });
}

module.exports = {
  isExecutableFile,
  findTool,
};

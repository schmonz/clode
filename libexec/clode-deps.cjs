'use strict';
// clode-deps — JS port of bin/clode's ensure_deps: resolve the BUILT TARGETS'
// (Claude Code's) runtime npm deps — the deps/claude/package.json manifest —
// into a user-owned dir, installing on first run and re-installing when the
// manifest changes (sig-gated). These are what `clode build` embeds as the
// ext-dep closure (ws, yaml, string-width, ...); they are NOT clode's own deps
// — clode itself has none (see test/clode-self-deps.test.cjs). Pure Node
// stdlib + sibling .cjs requires; runs before any ext-deps are ensured.
// Behavior-for-behavior with the sh launcher (which predates the deps/claude
// split — read "clode's runtime deps" in any surviving sh-era comment as "the
// deps clode builds INTO its targets").
//
// User-owned => no sudo. CLODE_DEPS overrides the dir AND, if already populated with
// a node_modules but no clode-written .deps-sig, opts out of auto-install (you manage
// it). CLODE_NPM overrides the npm binary (used verbatim, matching `${CLODE_NPM:-...}`).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sigOf } = require('./clode-resolve.cjs');
const { findTool } = require('./clode-hosttools.cjs');
const { depsStore } = require('./clode-paths.cjs');

// `[ -f "$p" ]`: exists AND is a regular file (any stat error -> false).
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// `[ -d "$p" ]`: exists AND is a directory (any stat error -> false).
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// `[ "$(cat "$p" 2>/dev/null)" = ... ]`: command substitution strips trailing
// newlines; a missing/unreadable file yields "".
function readSig(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

// How to spawn npm. On Windows npm IS a batch shim (npm.cmd), and Node can't spawn a
// .cmd/.bat directly (spawnSync -> EINVAL since the CVE-2024-27980 hardening), so route
// it through the command interpreter (cmd.exe /d /s /c). POSIX — or a bare .exe — spawns
// verbatim. This is the Windows parallel of the sh launcher invoking npm on PATH.
function npmInvocation(npm, args, env) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm)) {
    const comspec = (env && env.ComSpec) || process.env.ComSpec || 'cmd.exe';
    return [comspec, ['/d', '/s', '/c', npm, ...args]];
  }
  return [npm, args];
}

// Port of run_quiet around the npm subprocess: when verbose, stream its output live;
// otherwise buffer stdout+stderr and swallow on success, resurfacing it on failure
// (keeping the "see npm output above" diagnostic honest). Returns true on success.
function runNpmQuiet(verbose, npm, args, spawn, stderr, env) {
  const [cmd, cmdArgs] = npmInvocation(npm, args, env);
  if (verbose) {
    const r = spawn(cmd, cmdArgs, { stdio: 'inherit' });
    return r.status === 0;
  }
  const r = spawn(cmd, cmdArgs, { encoding: 'utf8' });
  if (r.status === 0) return true;
  // sh: `>"$_ql" 2>&1` then `cat "$_ql" >&2` — stdout then stderr, both to stderr.
  if (r.stdout) stderr.write(r.stdout);
  if (r.stderr) stderr.write(r.stderr);
  return false;
}

// Resolve + (re)install the built targets' (Claude Code's) runtime npm deps.
// Mirrors ensure_deps:
//   - DEPS_ROOT = CLODE_DEPS | ${XDG_DATA_HOME:-$HOME/.local/share}/clode
//   - manifest search order: LIBEXEC/deps/claude/package.json, then
//     HERE/../deps/claude/package.json (the normal repo layout: ROOT/deps/claude)
//   - early returns: no manifest; deps already installed at a sibling
//     deps/claude/node_modules ($HERE/../deps/claude/node_modules — a source
//     checkout that already ran `npm install --prefix deps/claude`); a
//     user-managed CLODE_DEPS (node_modules, no .deps-sig); the sig gate (fresh).
//   - else: log, resolve npm (CLODE_NPM verbatim, else `command -v npm`; none ->
//     two-line fail-loud + exit 1), mkdir DEPS_ROOT, copy manifest, `npm install
//     --prefix DEPS_ROOT --no-audit --no-fund --omit=dev` (run_quiet; failure ->
//     fail-loud + exit 1), write .deps-sig.
//
// opts: { libexec, here, verbose=false, npmPath=env.CLODE_NPM, env, fsm, stderr,
//         exit, log, spawn }. stderr/exit/spawn/log injectable for testability.
function ensureDeps(opts = {}) {
  const {
    libexec,
    here,
    verbose = false,
    env = process.env,
    stderr = process.stderr,
    exit = process.exit,
    spawn = spawnSync,
    // install=false is the USER RUNTIME contract (retire-node-runtime D2): never
    // shell npm — a real user runs the fused binary (deps embedded) or a managed
    // CLODE_DEPS. Only the build/CI caller (clode-fuse gathering deps to embed)
    // leaves it true. Default true preserves the existing build behavior.
    install = true,
  } = opts;
  const npmPath = 'npmPath' in opts ? opts.npmPath : env.CLODE_NPM;
  const emit = opts.log || ((m) => stderr.write(m + '\n'));
  const clodeLog = (m) => { if (verbose) emit(m); };

  // DEPS_ROOT="${CLODE_DEPS:-${XDG_DATA_HOME:-$HOME/.local/share}/clode}"
  const depsRoot = depsStore(env);

  // manifest: first of LIBEXEC/deps/claude/package.json,
  // HERE/../deps/claude/package.json that is a file. Both resolve to the same
  // ROOT/deps/claude/package.json in the normal repo layout; the two-tier
  // search only matters when CLODE_LIBEXEC points somewhere other than the
  // real checkout (an alternate packaging layout that ships its own
  // deps/claude alongside the libexec scripts).
  let manifest = '';
  for (const c of [
    path.join(libexec, 'deps', 'claude', 'package.json'),
    path.join(here, '..', 'deps', 'claude', 'package.json'),
  ]) {
    if (isFile(c)) { manifest = c; break; }
  }
  if (!manifest) return; // no manifest shipped -> nothing to ensure

  // deps/claude/node_modules already installed beside this checkout (a dev ran
  // `npm install --prefix deps/claude`, or CI already did it) -> nothing to
  // install here; clode-fuse.cjs's nmDir resolution finds it directly. This
  // used to check $HERE/../node_modules (the REPO ROOT's own node_modules,
  // from `npm install -g .`) — that was the exact conflation this whole
  // restructuring removes: a root-level node_modules was never "clode's own"
  // deps (clode has none), it was Claude Code's, mis-homed at the repo root.
  if (isDir(path.join(here, '..', 'deps', 'claude', 'node_modules'))) return;

  // A CLODE_DEPS dir with node_modules but no clode-written .deps-sig is user-managed:
  // trust it, never auto-install. (Our own managed dir HAS a .deps-sig, so it falls
  // through to the sig gate below and re-installs when the manifest changes.)
  if (
    env.CLODE_DEPS &&
    isDir(path.join(env.CLODE_DEPS, 'node_modules')) &&
    !isFile(path.join(env.CLODE_DEPS, '.deps-sig'))
  ) {
    return;
  }

  const sig = sigOf(manifest);
  if (isDir(path.join(depsRoot, 'node_modules')) &&
      readSig(path.join(depsRoot, '.deps-sig')) === sig) {
    return; // already fresh for this manifest
  }

  // D2: the user runtime never shells npm. Deps ship embedded in the fused binary
  // (materialized as a sibling node_modules -> the early return above), so reaching
  // here on the runtime path means a non-fused clode with no deps present. Fail
  // loud toward the binary/build rather than silently installing.
  if (!install) {
    // Reachable only on a non-fused clode (bin/clode under node) whose deps aren't
    // present — in practice a SOURCE CHECKOUT that never ran
    // `npm install --prefix deps/claude`. Point there first; a released binary
    // carries its deps as members and never lands here.
    stderr.write('clode: runtime dependencies (ws, yaml, string-width, ...) are not installed.\n');
    stderr.write('clode: - in a source checkout, run `npm install --prefix deps/claude` (or `npm ci --prefix deps/claude`) here.\n');
    stderr.write('clode: - otherwise use a released clode binary (deps are embedded), or point\n');
    stderr.write('clode:   CLODE_DEPS at a node_modules you have populated with them.\n');
    return exit(1);
  }

  clodeLog('clode: installing dependencies...');

  // `${CLODE_NPM:-$(command -v npm)}`: CLODE_NPM used verbatim when set, else PATH.
  const npm = npmPath || findTool('npm', { env });
  if (!npm) {
    stderr.write('clode: need npm to install runtime dependencies (ws, yaml, string-width, ...);\n');
    stderr.write('       install npm, or set CLODE_DEPS to a node_modules you populate yourself.\n');
    return exit(1);
  }

  fs.mkdirSync(depsRoot, { recursive: true });
  fs.copyFileSync(manifest, path.join(depsRoot, 'package.json'));

  const args = ['install', '--prefix', depsRoot, '--no-audit', '--no-fund', '--omit=dev'];
  if (!runNpmQuiet(verbose, npm, args, spawn, stderr, env)) {
    stderr.write('clode: dependency install failed (see npm output above).\n');
    return exit(1);
  }

  fs.writeFileSync(path.join(depsRoot, '.deps-sig'), sig + '\n');
}

module.exports = { ensureDeps };

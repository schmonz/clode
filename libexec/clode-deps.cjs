'use strict';
// clode-deps — JS port of bin/clode's ensure_deps: resolve clode's runtime npm
// deps (the package.json manifest) into a user-owned dir, installing on first run
// and re-installing when the manifest changes (sig-gated). These back the bundle's
// ext-deps (ws, yaml, string-width, ...). Pure Node stdlib + sibling .cjs requires;
// runs before any ext-deps are ensured. Behavior-for-behavior with the sh launcher.
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

// Port of run_quiet around the npm subprocess: when verbose, stream its output live;
// otherwise buffer stdout+stderr and swallow on success, resurfacing it on failure
// (keeping the "see npm output above" diagnostic honest). Returns true on success.
function runNpmQuiet(verbose, npm, args, spawn, stderr) {
  if (verbose) {
    const r = spawn(npm, args, { stdio: 'inherit' });
    return r.status === 0;
  }
  const r = spawn(npm, args, { encoding: 'utf8' });
  if (r.status === 0) return true;
  // sh: `>"$_ql" 2>&1` then `cat "$_ql" >&2` — stdout then stderr, both to stderr.
  if (r.stdout) stderr.write(r.stdout);
  if (r.stderr) stderr.write(r.stderr);
  return false;
}

// Resolve + (re)install clode's runtime npm deps. Mirrors ensure_deps:
//   - DEPS_ROOT = CLODE_DEPS | ${XDG_DATA_HOME:-$HOME/.local/share}/clode
//   - manifest search order: LIBEXEC/package.json, then HERE/../package.json
//   - early returns: no manifest; deps ship in clode's own $HERE/../node_modules;
//     a user-managed CLODE_DEPS (node_modules, no .deps-sig); the sig gate (fresh).
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
  } = opts;
  const npmPath = 'npmPath' in opts ? opts.npmPath : env.CLODE_NPM;
  const emit = opts.log || ((m) => stderr.write(m + '\n'));
  const clodeLog = (m) => { if (verbose) emit(m); };

  // DEPS_ROOT="${CLODE_DEPS:-${XDG_DATA_HOME:-$HOME/.local/share}/clode}"
  const depsRoot = depsStore(env);

  // manifest: first of LIBEXEC/package.json, HERE/../package.json that is a file.
  let manifest = '';
  for (const c of [
    path.join(libexec, 'package.json'),
    path.join(here, '..', 'package.json'),
  ]) {
    if (isFile(c)) { manifest = c; break; }
  }
  if (!manifest) return; // no manifest shipped -> nothing to ensure

  // An npm install ships clode's deps in its own node_modules -> nothing to install.
  if (isDir(path.join(here, '..', 'node_modules'))) return;

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
  if (!runNpmQuiet(verbose, npm, args, spawn, stderr)) {
    stderr.write('clode: dependency install failed (see npm output above).\n');
    return exit(1);
  }

  fs.writeFileSync(path.join(depsRoot, '.deps-sig'), sig + '\n');
}

module.exports = { ensureDeps };

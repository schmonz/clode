'use strict';
// Run npm by launching its OWN JS CLI under THIS node, rather than the `npm`/`npm.cmd`
// launcher. Uniform on every OS, and it sidesteps the Windows-only `npm.cmd`+shell path
// (cmd.exe can't run from a UNC cwd and strips quotes from args). npm ships inside every
// node install; the file sits at a different spot on Windows vs POSIX, so probe both.
//
// Shared by build-clode-main.mjs and build-naude.mjs — the two build scripts carried
// byte-identical copies of this logic, differing only in the thrown-error prefix
// ('build-clode-main:' / 'build-naude:'). Both functions take an optional options bag so
// each caller keeps its own prefix; existsSync/execFileSync/execPath are ALSO
// overridable there — solely so tests can probe the candidate order and error text
// without touching the real filesystem or shelling real npm.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

function npmCliPath(opts = {}) {
  const { prefix = 'npm-cli', existsSync = fs.existsSync, execPath = process.execPath } = opts;
  const d = path.dirname(execPath);
  const found = [
    path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'),              // Windows dist layout
    path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX dist layout
  ].find((p) => existsSync(p));
  if (!found) throw new Error(`${prefix}: could not locate npm-cli.js next to ${execPath}`);
  return found;
}

// A version-manager shim (asdf, mise, volta all ship one; nvm does not, since it
// mutates PATH directly instead) resolves ITS OWN version by walking up from the
// CURRENT WORKING DIRECTORY looking for a .tool-versions/.node-version/package.json
// field. That is exactly what every caller of runNpm does NOT have once builds moved
// off-tree (build-scratch.cjs's whole point): `cd <scratch-dir> && sh -c "node -v"`
// exits 126 ("No version is set for command node") on THIS box, proven by running it,
// while the same command from inside the checkout succeeds — the checkout has a
// .tool-versions the scratch dir does not. npm's own lifecycle scripts (e.g. esbuild's
// postinstall, `sh -c "node install.js"`) hit this exact failure the moment they run
// with cwd outside the checkout.
//
// The fix has to be portable across every shim-based manager (asdf/mise/volta) and
// every OS, without knowing or writing any one manager's config format — so it does
// not touch the filesystem at all: prepend the directory of the node ALREADY RUNNING
// us (process.execPath, a real binary, never a shim) to the child's PATH. A bare
// `node` invocation inside npm's lifecycle scripts then resolves to that real binary
// before any shim on PATH gets a chance to guess wrong, in any cwd, on any manager —
// including no manager at all (this is also harmless there: the real node's own dir
// merely gets listed first).
function envWithRealNodeOnPath(env = process.env, execPath = process.execPath) {
  const dir = path.dirname(execPath);
  // PATH's env-var key is case-sensitive on POSIX ('PATH') but Windows' actual key can
  // be spelled 'Path' (or any casing) — find whichever key is already there so we
  // extend it in place instead of creating a second, differently-cased PATH that
  // shadows or is shadowed depending on lookup order.
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const existing = env[key];
  return { ...env, [key]: existing ? `${dir}${path.delimiter}${existing}` : dir };
}

function runNpm(args, opts, cliOpts = {}) {
  const execFileSync = cliOpts.execFileSync || childProcess.execFileSync;
  const execPath = cliOpts.execPath || process.execPath;
  const baseEnv = (opts && opts.env) || process.env;
  const env = envWithRealNodeOnPath(baseEnv, execPath);
  execFileSync(process.execPath, [npmCliPath(cliOpts), ...args], { ...opts, env });
}

module.exports = { npmCliPath, runNpm, envWithRealNodeOnPath };

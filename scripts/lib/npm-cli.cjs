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

function runNpm(args, opts, cliOpts = {}) {
  const execFileSync = cliOpts.execFileSync || childProcess.execFileSync;
  execFileSync(process.execPath, [npmCliPath(cliOpts), ...args], opts);
}

module.exports = { npmCliPath, runNpm };

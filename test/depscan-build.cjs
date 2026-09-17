'use strict';
// Build depscan once, and share it. Not a .test.cjs file on purpose: requiring
// one node:test file from another re-registers its tests in the requiring
// file, so they run twice and report twice.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildDepscan } = require('../scripts/build-depscan.cjs');

const repo = path.join(__dirname, '..');

// cmake configure+build is seconds, but it is not free, and every caller wants
// the same binary. Built lazily so merely requiring this file costs nothing.
let EXE = null;
function depscanExe() {
  if (EXE) return EXE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depscan-build-'));
  EXE = buildDepscan(repo, dir, {
    run: (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }),
  });
  return EXE;
}

// Run depscan and return { status, stdout, stderr } WITHOUT throwing on a
// nonzero exit — the exit code is the thing under test in half these cases.
function runDepscan(args) {
  const r = spawnSync(depscanExe(), args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = { depscanExe, runDepscan };

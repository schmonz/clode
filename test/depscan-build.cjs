'use strict';
// Build depscan once, and share it. Not a .test.cjs file on purpose: requiring
// one node:test file from another re-registers its tests in the requiring
// file, so they run twice and report twice.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');

// cmake configure+build is seconds, but it is not free, and every caller wants
// the same binary. Built lazily so merely requiring this file costs nothing.
let EXE = null;
function depscanExe() {
  if (EXE) return EXE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depscan-build-'));
  // A dynamic import would make every caller async; buildDepscan is ESM, so
  // this shells out to the same entry point the build uses instead.
  const { buildDepscan } = requireEsmSync('../scripts/build-depscan.mjs');
  EXE = buildDepscan(repo, dir, {
    run: (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }),
  });
  return EXE;
}

// scripts/build-depscan.mjs is ESM and this file is CJS. Rather than make
// every test async, run the tiny build through node -e and take the path back
// on stdout. Phase 4c converts build-depscan.mjs to CJS, after which this
// helper collapses to a plain require() -- leave a note, not a workaround that
// outlives its reason.
function requireEsmSync(rel) {
  const mod = path.join(__dirname, rel).replace(/\\/g, '/');
  return {
    buildDepscan: (repoDir, outDir, opts) => {
      const script = `import { buildDepscan } from ${JSON.stringify('file://' + mod)};`
        + `import { execFileSync } from 'node:child_process';`
        + `process.stdout.write(buildDepscan(${JSON.stringify(repoDir)}, ${JSON.stringify(outDir)},`
        + ` { run: (c, a) => execFileSync(c, a, { stdio: 'pipe' }), jobs: ${JSON.stringify(opts.jobs || 1)} }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`buildDepscan failed: ${r.stderr}`);
      return r.stdout.trim();
    },
  };
}

// Run depscan and return { status, stdout, stderr } WITHOUT throwing on a
// nonzero exit — the exit code is the thing under test in half these cases.
function runDepscan(args) {
  const r = spawnSync(depscanExe(), args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = { depscanExe, runDepscan };

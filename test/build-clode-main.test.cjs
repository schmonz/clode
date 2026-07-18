'use strict';
// Task 4: build-clode-main.mjs must ALSO pre-build the naude entry bundle
// (build/bundle/naude-entry.bundle.cjs, esbuilt from libexec/naude-entry.cjs)
// so esbuild never has to run on the user's machine when `clode build --naude`
// assembles a naude. Unlike clode-main.bundle.cjs, this bundle carries NO
// `define` (Task 3 already turned the builder path into a SEA asset, not an
// esbuild-time constant) — so it must be our-source-only: no __CLODE_BUILDER__
// literal, and no absolute host/repo path baked in by accident.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO, 'build');
const OUT = path.join(BUILD_DIR, 'bundle', 'naude-entry.bundle.cjs');

test('build-clode-main.mjs also pre-builds naude-entry.bundle.cjs', () => {
  // This runs the REAL build-clode-main.mjs, which writes into REPO/build/. On a
  // dev box build/ already exists (a prior build), but on a clean checkout (CI)
  // it does not — creating it trips run.mjs's hermeticity guard (a test must not
  // leave a real dir behind). Snapshot whether build/ pre-existed and, if this
  // test created it, remove it afterward so the suite stays hermetic.
  const buildPreexisted = fs.existsSync(BUILD_DIR);
  try {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-clode-main.mjs')], {
      cwd: REPO,
      stdio: 'inherit',
    });

    assert.ok(fs.existsSync(OUT), `expected ${OUT} to exist`);
    const contents = fs.readFileSync(OUT, 'utf8');
    assert.ok(contents.length > 0, 'naude-entry.bundle.cjs must be non-empty');

    // The regression this design removes: a per-builder bundle baked with
    // __CLODE_BUILDER__ (or any other builder-specific define). naude-entry has
    // no version/builder constant, so none should appear in the output.
    assert.ok(!contents.includes('__CLODE_BUILDER__'),
      'naude-entry.bundle.cjs must not contain a __CLODE_BUILDER__ literal (would make it builder-specific)');

    // Crude but effective "not builder-specific" check: no absolute host/repo
    // path baked into the bundle (esbuild sourcemaps/comments can leak these).
    assert.ok(!contents.includes('/Users/'),
      'naude-entry.bundle.cjs must not contain a /Users/ host path');
    assert.ok(!contents.includes(REPO),
      'naude-entry.bundle.cjs must not contain this repo\'s own absolute path');
  } finally {
    if (!buildPreexisted) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  }
});

'use strict';
// Task 4: build-clode-main.mjs must ALSO pre-build the naude entry bundle
// (build/bundle/naude-entry.bundle.cjs, esbuilt from libexec/naude-entry.cjs)
// so esbuild never has to run on the user's machine when `clode build naude`
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
    // CAPTURED, NOT INHERITED, and the capture is put back into the failure. With
    // `stdio: 'inherit'` execFileSync's thrown error carries `stdout: null,
    // stderr: null` and says only "Command failed" — the child's real complaint
    // went to the runner's stream, ending up somewhere near this assertion rather
    // than in it. That is how a `Cannot find module 'esbuild'` from
    // ensureToolchain's own loader got reported here as a nameless non-zero exit
    // (2026-09-21), and it is the same shape as the node-shim defect where a
    // child's output was thrown away and the failure named the wrong thing.
    try {
      execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-clode-main.mjs')], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      // Both streams: the script narrates on stderr (`esbuild -> ...`), but a
      // spawned npm's diagnosis can land on either.
      const said = [e.stdout, e.stderr].map((s) => (s || '').trim()).filter(Boolean).join('\n');
      throw new Error(`scripts/build-clode-main.mjs failed (${e.message}).\nIt said:\n${said || '(nothing)'}`);
    }

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

// ---------------------------------------------------------------------------
// ensureToolchain's idempotence check must ask the question the script ANSWERS
// WITH.
//
// The check was `existsSync(node_modules/.bin/esbuild)`; the use, forty lines
// down, is `toolRequire('esbuild').buildSync(...)`. Two different properties, so
// a toolchain cache that satisfied the first and not the second was declared
// provisioned and then died in the module loader with `Cannot find module
// 'esbuild'` — no install re-run, because the check said there was nothing to do.
//
// That is not hypothetical. toolchainDir() resolves under $TMPDIR (see
// scripts/build-scratch.cjs's candidate order), and macOS reaps /var/folders/*/T
// on its own: com.apple.bsd.dirhelper, StartCalendarInterval 03:35 daily,
// CLEAN_FILES_OLDER_THAN_DAYS=3, deleting FILES by atime and leaving the
// DIRECTORIES standing. On this box on 2026-09-21 at 03:39:31 it took esbuild's
// package.json and lib/main.js (atime 09-17) and spared node_modules/.bin/esbuild
// — a symlink — pointing at the one file it left, the 10.5MB native binary a
// build had exec'd at 03:37. The cache looked provisioned and could not be loaded.
//
// Extracted and run against fixtures (the extractFunction pattern
// test/esbuild-edge.test.cjs uses on build-tjs.cjs's ensureEsbuild) rather than
// by reaping a real toolchain dir: the claim is about the DECISION, and a real
// `npm ci` is neither needed to state it nor hermetic to run.
const buildMainSrc = fs.readFileSync(path.join(REPO, 'scripts', 'build-clode-main.mjs'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-clode-main.mjs`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// A toolchain dir in the shape dirhelper leaves behind: the .bin entry present,
// the esbuild PACKAGE gone.
function reapedToolchain() {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'reaped-toolchain-'));
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'esbuild'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'esbuild', 'lib'), { recursive: true });
  return dir;
}

function runEnsureToolchain({ toolchain, toolRequire, runNpm }) {
  const fn = new Function('fs', 'path', 'REPO', 'TOOLCHAIN', 'toolRequire', 'runNpm', 'console',
    `${extractFunction(buildMainSrc, 'ensureToolchain')}\nreturn ensureToolchain;`)(
    fs, path, REPO, toolchain, toolRequire, runNpm, { error() {} });
  return fn();
}

test('ensureToolchain reinstalls a toolchain whose esbuild cannot be loaded', () => {
  const dir = reapedToolchain();
  try {
    let installed = false;
    const calls = [];
    const toolRequire = (name) => {
      assert.strictEqual(name, 'esbuild');
      if (!installed) throw Object.assign(new Error("Cannot find module 'esbuild'"), { code: 'MODULE_NOT_FOUND' });
      return { transformSync: () => ({ code: '' }), buildSync: () => {} };
    };
    runEnsureToolchain({
      toolchain: dir,
      toolRequire,
      runNpm: (args, opts) => { calls.push({ args, opts }); installed = true; },
    });
    assert.strictEqual(calls.length, 1,
      'a toolchain whose esbuild does not load must be re-provisioned, not skipped because '
      + 'node_modules/.bin/esbuild happens to still be there');
    assert.strictEqual(calls[0].opts.cwd, dir, 'the install must target the toolchain dir');
    assert.ok(calls[0].args.includes('ci') || calls[0].args.includes('install'),
      `expected an npm install command, got ${JSON.stringify(calls[0].args)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureToolchain installs nothing when esbuild already loads', () => {
  const dir = reapedToolchain();
  try {
    runEnsureToolchain({
      toolchain: dir,
      toolRequire: () => ({ transformSync: () => ({ code: '' }), buildSync: () => {} }),
      runNpm: () => { throw new Error('ensureToolchain re-installed a toolchain that already works'); },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureToolchain refuses when the install leaves esbuild still unloadable', () => {
  const dir = reapedToolchain();
  try {
    assert.throws(() => runEnsureToolchain({
      toolchain: dir,
      toolRequire: () => { throw Object.assign(new Error("Cannot find module 'esbuild'"), { code: 'MODULE_NOT_FOUND' }); },
      runNpm: () => {},
    }), (e) => {
      assert.match(e.message, /esbuild/, 'the refusal must name esbuild');
      assert.ok(e.message.includes(dir), `the refusal must name the toolchain dir, got: ${e.message}`);
      return true;
    }, 'an install that did not produce a loadable esbuild must refuse here, not fail later in the loader');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

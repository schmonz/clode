'use strict';

// Contract test for scripts/tjs-source-reset.mjs (resetCheckoutToPristine):
// build-tjs's applyPatches mutates the vendored txiki checkout in place with no
// rollback, so a killed/failed build leaves it partially patched. The reset
// must restore pristine source before the next build's patches apply — reverting
// tracked edits, sweeping untracked patch-created files (deps/wurl, new src
// modules), and preserving the esbuild node_modules cache upstream doesn't
// gitignore — including inside submodules. All on throwaway repos in os.tmpdir()
// (never the NFS tree), so it runs the same locally and in CI.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
const quietRun = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
// Read a file with line endings normalized: Git-for-Windows' core.autocrlf
// smudges LF->CRLF on checkout, so a reverted 'ORIGINAL\n' reads back as
// 'ORIGINAL\r\n'. The revert still happened — the EOL is irrelevant to it.
const readLF = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
}

test('resetCheckoutToPristine: reverts tracked, sweeps untracked, preserves keep-path', async () => {
  const { resetCheckoutToPristine } = await import('../scripts/tjs-source-reset.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-reset-'));
  try {
    initRepo(root);
    fs.writeFileSync(path.join(root, 'tracked.c'), 'ORIGINAL\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');

    // Simulate a poisoned partial build:
    fs.writeFileSync(path.join(root, 'tracked.c'), 'PATCHED\n');            // tracked edit
    fs.writeFileSync(path.join(root, 'mod_new.c'), 'generated\n');          // patch-created src
    fs.mkdirSync(path.join(root, 'deps/wurl'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deps/wurl/wurl_url.c'), 'generated\n'); // patch-created dep
    fs.mkdirSync(path.join(root, 'node_modules/esbuild'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/esbuild/pkg'), 'cache\n'); // keep-path
    fs.writeFileSync(path.join(root, 'deps/wurl/._idna_allow.h'), 'macos sidecar\n'); // AppleDouble turd

    resetCheckoutToPristine(root, { run: quietRun });

    assert.strictEqual(readLF(path.join(root, 'tracked.c')), 'ORIGINAL\n',
      'tracked edit reverted');
    assert.ok(!fs.existsSync(path.join(root, 'mod_new.c')), 'patch-created src removed');
    assert.ok(!fs.existsSync(path.join(root, 'deps/wurl')), 'patch-created deps/wurl removed');
    assert.ok(fs.existsSync(path.join(root, 'node_modules/esbuild/pkg')),
      'node_modules keep-path preserved (no esbuild reinstall)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resetCheckoutToPristine: skips the Unix find sweep on win32', async () => {
  const { resetCheckoutToPristine } = await import('../scripts/tjs-source-reset.mjs');
  const calls = [];
  const spy = (cmd, args) => { calls.push(cmd); };
  // No real git ops run (spy swallows them); we only assert the platform gate.
  resetCheckoutToPristine('/nowhere', { run: spy, platform: 'win32' });
  assert.ok(!calls.includes('find'), 'find sweep must not run on win32');
  assert.ok(calls.includes('git'), 'git checkout/clean still run on win32');
});

test('resetCheckoutToPristine: resets submodule working trees recursively', async () => {
  const { resetCheckoutToPristine } = await import('../scripts/tjs-source-reset.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-reset-sub-'));
  try {
    // A standalone repo to embed as a submodule (local path).
    const subRemote = path.join(base, 'subremote');
    initRepo(subRemote);
    fs.writeFileSync(path.join(subRemote, 'lib.c'), 'ORIG\n');
    git(subRemote, 'add', '.');
    git(subRemote, 'commit', '-qm', 'sub init');

    const main = path.join(base, 'main');
    initRepo(main);
    // Local-path submodules require the protocol allow-list on modern git.
    execFileSync('git', ['-C', main, '-c', 'protocol.file.allow=always',
      'submodule', 'add', subRemote, 'deps/sub'], { stdio: 'ignore' });
    git(main, 'commit', '-qm', 'add sub');

    // Dirty the submodule working tree the way a libuv/quickjs fixup would.
    fs.writeFileSync(path.join(main, 'deps/sub/lib.c'), 'DIRTY\n');
    fs.writeFileSync(path.join(main, 'deps/sub/untracked.c'), 'x\n');

    resetCheckoutToPristine(main, { run: quietRun });

    assert.strictEqual(readLF(path.join(main, 'deps/sub/lib.c')), 'ORIG\n',
      'submodule tracked edit reverted');
    assert.ok(!fs.existsSync(path.join(main, 'deps/sub/untracked.c')),
      'submodule untracked file removed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

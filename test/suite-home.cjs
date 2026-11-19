'use strict';
// suite-home: the test suite runs with a THROWAWAY HOME, USERPROFILE and CLAUDE_CONFIG_DIR, never the developer's
// (grep-native Task 10b fix round 3, ruling G33).
//
// WHY CENTRAL. Per-test homes left holes faster than guards could find them: rows that inherited the runner's HOME ran
// the developer's ~/.claude/settings.json hooks (an iTerm2 status hook blocking 30 s per call timed ten of them out),
// and every test that built a quaude booted the bundle against the real home (it left ~/.claude.json, ~/.tjs/*). A
// whole-suite default, set once like CLODE_STATE_ROOT (test/run.mjs), reaches every child of every test, including
// the ones no guard can see. Tests that need DISTINCT homes still make their own (test/throwaway-home.cjs).
//
// THE REAL VALUES are kept under ONE name, CLODE_TEST_REAL_HOME (JSON: HOME, USERPROFILE, CLAUDE_CONFIG_DIR), for the
// one run that exists to use them: fidelity/interactive-live-turn's opt-in real-credential turn. Nothing else may read
// it (test/suite-home-hermetic.test.cjs, fail-closed).
//
// WHAT THE SUITE STILL NEEDS FROM THE REAL HOME is handed over as an EXPLICIT path, never as the home:
//   - CLODE_TEST_PROVIDER_STORE: the operator's Claude provider store (<home>/.local/share/clode/providers), READ by
//     test/provider-resolve.cjs to find carves; the runner's hermetic guard still watches it for writes;
//   - PATH: the directory of the node running the suite first, so `node` by name never needs a version manager's
//     shim (asdf's resolve through HOME);
//   - CLODE_TEST_USER_CACHE: the developer's clode cache (<home>/.cache/clode: the carve caches and templates a few
//     gates read), and CLODE_TJS_VENDOR (unless set) its txiki checkout, which the engine builds share as before;
//   - CLODE_TEST_NATIVE_VERSIONS and CLODE_TEST_NATIVE_LAUNCHER: the native install's versions dir and launcher, read
//     by the tests that compare against it;
//   - git: a fixed test identity (GIT_AUTHOR_* / GIT_COMMITTER_*), so a commit in a scratch repo never needs (or
//     reads) the developer's ~/.gitconfig, and `safe.directory` for this checkout (a command-scope GIT_CONFIG_* entry,
//     which git honours as protected configuration), which the developer's ~/.gitconfig used to grant.
//
// Idempotent and inherited: the first require in a process tree applies it; a child (CLODE_TEST_REAL_HOME already set)
// keeps what it was given. test/run.mjs requires it first; a standalone `node --test file` gets the same through the
// helpers that launch the bundle (provider-resolve.cjs, oracle-models.cjs, node-shim-helper.cjs, e2e.cjs, which require
// this module).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL_NAME = 'CLODE_TEST_REAL_HOME';
const PREFIX = 'clode-test-home-';
// the suite home THIS process made (null in a child, which inherits its parent's): the only dir cleanup may remove
let made = null;

function applySuiteHome(env = process.env) {
  if (env[REAL_NAME]) return JSON.parse(env[REAL_NAME]);
  const real = { HOME: env.HOME || os.homedir(), USERPROFILE: env.USERPROFILE || null, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || null };
  env[REAL_NAME] = JSON.stringify(real);
  if (!env.CLODE_TEST_PROVIDER_STORE) env.CLODE_TEST_PROVIDER_STORE = path.join(real.HOME, '.local', 'share', 'clode', 'providers');
  if (!env.CLODE_TEST_USER_CACHE) env.CLODE_TEST_USER_CACHE = path.join(env.XDG_CACHE_HOME || path.join(real.HOME, '.cache'), 'clode');
  if (!env.CLODE_TJS_VENDOR && !env.CLODE_TJS_LOCAL_ROOT) env.CLODE_TJS_VENDOR = path.join(env.CLODE_TEST_USER_CACHE, 'tjs-vendor');
  if (!env.CLODE_TEST_NATIVE_VERSIONS) env.CLODE_TEST_NATIVE_VERSIONS = path.join(real.HOME, '.local', 'share', 'claude', 'versions');
  if (!env.CLODE_TEST_NATIVE_LAUNCHER) env.CLODE_TEST_NATIVE_LAUNCHER = path.join(real.HOME, '.local', 'bin', 'claude');
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = 'safe.directory';
  env[`GIT_CONFIG_VALUE_${n}`] = path.resolve(__dirname, '..');
  env.GIT_CONFIG_COUNT = String(n + 1);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  fs.mkdirSync(path.join(home, '.claude'));
  made = home;
  process.once('exit', () => { removeOwnSuiteHome(home); });
  env.HOME = home;
  env.USERPROFILE = home;
  env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  const nodeDir = path.dirname(process.execPath);
  if (!(env.PATH || '').split(path.delimiter).includes(nodeDir)) env.PATH = [nodeDir, env.PATH || ''].join(path.delimiter);
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) if (!env[k]) env[k] = 'clode-test';
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) if (!env[k]) env[k] = 'clode-test@example.invalid';
  return real;
}

// The real values, for the run that exists to use them (and test/run.mjs, which watches the real dirs).
function realHome(env = process.env) {
  return env[REAL_NAME] ? JSON.parse(env[REAL_NAME]) : null;
}

// CLEANUP, owned here and nowhere else (fix round 4). test/run.mjs once removed `process.env.HOME` at exit, read back
// after this module ran; but with CLODE_TEST_REAL_HOME already set this module leaves HOME alone, so that was the REAL
// home. Remove a dir only if THIS process made it, it lies directly under os.tmpdir(), it carries the prefix, and it is
// neither the real home nor an ancestor of it. Returns whether it removed anything.
//
// A REMOVAL THAT FAILS SAYS WHAT REFUSED. windows-amd64-tui (CI 44443821699, the first run with a suite home) passed
// its test and then died at exit with node's bare "EPERM, Permission denied: <the suite home>" from this rmSync:
// node's rm names only the root it was given, never the entry inside that refused, so the log could not say which
// file or which process. (Not a read-only file: an official Windows node clears that attribute and retries,
// src/node_file.cc RmSync.) It stays a failure (something outlived the test with this home in its environment, or
// holds a file in it), but now one that names each entry that refused removal, by path, code and mode.
// `rm` is injectable for test/suite-home-cleanup.test.cjs.
function removeOwnSuiteHome(dir, { rm = fs.rmSync } = {}) {
  if (!dir || !made) return false;
  const abs = path.resolve(String(dir));
  if (abs !== made) return false;
  if (path.dirname(abs) !== path.resolve(os.tmpdir()) || !path.basename(abs).startsWith(PREFIX)) return false;
  const real = realHome();
  if (real && real.HOME) {
    const r = path.resolve(real.HOME);
    if (r === abs || r.startsWith(abs + path.sep)) return false;
  }
  try { rm(abs, { recursive: true, force: true }); } catch (e) { throw refusedRemoval(abs, e, rm); }
  made = null;
  return true;
}
// Each entry under `root` that still refuses removal, deepest first (the rest are removed on the way: the whole dir is
// being removed anyway), as an Error naming them.
function refusedRemoval(root, cause, rm) {
  const refused = [];
  // -> whether p is gone; a directory holding a refused entry is not tried itself (it would only refuse as not empty)
  const visit = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return true; }
    let clear = true;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch (e) { refused.push([p, e.code, st.mode]); return false; }
      for (const n of names) clear = visit(path.join(p, n)) && clear;
    }
    if (p === root || !clear) return clear;
    try { rm(p, { recursive: true, force: true }); return true; } catch (e) { refused.push([p, e.code, st.mode]); return false; }
  };
  visit(root);
  let rootGone = false;
  if (!refused.length) { try { rm(root, { recursive: true, force: true }); rootGone = true; } catch { /* named below */ } }
  const named = refused.slice(0, 40).map(([p, code, mode]) => `${path.relative(root, p) || '.'} (${code}, mode ${(mode & 0o7777).toString(8)})`);
  const e = new Error(`suite-home: could not remove ${root} at exit (${cause.code || cause.message}). `
    + (refused.length ? `${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} under it refused removal: ${named.join('; ')}${refused.length > 40 ? '; ...' : ''}. `
      : rootGone ? 'On a second pass, entry by entry, nothing refused: whatever held it let go meanwhile. '
        : 'Every entry under it was removed one by one; the directory itself refused. ')
    + 'On Windows an entry refuses while another process holds it open or has it as its working directory: a process that '
    + 'outlived this test with this home in its environment.');
  e.code = cause.code;
  e.cause = cause;
  return e;
}

applySuiteHome();

const userCacheDir = (env = process.env) => env.CLODE_TEST_USER_CACHE || path.join(os.homedir(), '.cache', 'clode');

module.exports = { applySuiteHome, realHome, removeOwnSuiteHome, REAL_NAME, userCacheDir };

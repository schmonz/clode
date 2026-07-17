#!/usr/bin/env node
'use strict';
// run.mjs — the cross-platform test runner. Replaces the sh run-all.sh with ONE node
// orchestrator that works identically on Linux/macOS/Windows. `npm test` -> this.
// Offline by default; `--online` opts in. Sets CLODE_NODE, installs+preflights the PTY
// harness, then runs the hermetic guard around `node --test test/*.test.cjs`, exiting
// nonzero on any test failure or hermeticity violation.
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../test
const ROOT = path.dirname(HERE);                           // repo root
process.chdir(ROOT);

// Offline gate: the runner is the single source of truth; an ambient CLODE_OFFLINE never leaks in.
const arg = process.argv[2] || '--offline';
if (arg === '--online') delete process.env.CLODE_OFFLINE;
else if (arg === '--offline') process.env.CLODE_OFFLINE = '1';
else { console.error('usage: node test/run.mjs [--online|--offline]'); process.exit(2); }

// CLODE_NODE = the concrete node running this runner (already the real binary; no shim canonicalization).
process.env.CLODE_NODE = process.execPath;

// Platform-tagged harness dir + NODE_PATH (path.delimiter, NOT a hardcoded ':').
const { platformTag } = require('../scripts/platform-tag.cjs');
const TAG = platformTag();
const HARNESS = path.join(ROOT, 'test', '.harness', TAG);
process.env.NODE_PATH = [path.join(HARNESS, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean).join(path.delimiter);

// npm via its own npm-cli.js under THIS node (cross-platform; no npm/.cmd/shell) — same
// approach as scripts/build-clode-main.mjs.
function npmCliPath() {
  const d = path.dirname(process.execPath);
  const found = [
    path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'),              // Windows dist layout
    path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX dist layout
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`run: could not locate npm-cli.js next to ${process.execPath}`);
  return found;
}

function harnessOk() {
  return spawnSync(process.execPath, [path.join('test', 'harness-preflight.cjs')], { stdio: 'ignore' }).status === 0;
}

// Install the PTY/TUI harness into the tagged dir if preflight fails, then re-check.
if (!harnessOk()) {
  console.error(`run: installing PTY test harness deps into test/.harness/${TAG} ...`);
  fs.mkdirSync(HARNESS, { recursive: true });
  fs.copyFileSync(path.join('test', 'package.json'), path.join(HARNESS, 'package.json'));
  const lock = path.join('test', 'package-lock.json');
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(HARNESS, 'package-lock.json'));
  try {
    execFileSync(process.execPath, [npmCliPath(), 'install'], { cwd: HARNESS, stdio: 'inherit' });
  } catch {
    console.error('run: harness dep install failed (see npm output above)');
    process.exit(2);
  }
  if (!harnessOk()) { console.error('run: PTY test harness unavailable (see above)'); process.exit(2); }
}

// Hermetic guard (pure node; required in-process). Watch the real dirs a test must never touch.
const guard = require('./hermetic-guard.cjs');
const home = os.homedir();
const dataBase = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const cacheBase = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
const REAL_STORE = path.join(dataBase, 'clode');
const GUARD_WATCH = [REAL_STORE, path.join(cacheBase, 'clode'), path.join(home, '.local', 'bin'), path.join(ROOT, 'build')];
if (guard.preflight(REAL_STORE).length) {
  console.error(`run: REAL store contaminated with *-clode-test deps under ${REAL_STORE}`);
  process.exit(2);
}
const before = guard.snapshot(GUARD_WATCH);

// Run the node tests: discover test/*.test.cjs (no shell glob) and run under THIS node.
// Exclude dotfiles (leading '.') to match the POSIX glob's default — e.g. gitignored
// AppleDouble `._*.test.cjs` sidecars must NOT be picked up as test modules.
const files = fs.readdirSync('test').filter((f) => f.endsWith('.test.cjs') && !f.startsWith('.')).map((f) => path.join('test', f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
let fails = res.status === 0 ? 0 : 1;

// Postflight: no watched real dir changed, and the store still has no fake deps.
const after = guard.snapshot(GUARD_WATCH);
const changed = guard.diffSnapshots(before, after);
if (changed.length) {
  console.error('HERMETICITY VIOLATION — a test changed a real dir:');
  for (const c of changed) console.error('    ' + c);
  fails = 1;
}
if (guard.preflight(REAL_STORE).length) {
  console.error('HERMETICITY VIOLATION — a test seeded *-clode-test deps into the real store');
  fails = 1;
}

process.exit(fails ? 1 : 0);

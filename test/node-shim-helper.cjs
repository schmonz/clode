'use strict';
// Locates the patched tjs binary and runs entries through the node-shim
// loader. Tests SKIP when no binary is present (CLODE_TJS or build/tjs/tjs).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { tjsBin } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');
const LOADER = path.join(REPO, 'libexec/node-shim/loader.cjs');

function tjsPath() {
  // Default is the platform-unique path (build/tjs/<osToken>-<arch>) — never the
  // bare build/tjs/tjs, whose shared location let a foreign-platform binary linger
  // and defeat this gate (a macOS Mach-O on a NetBSD tree → exec format error).
  const cand = process.env.CLODE_TJS || tjsBin(REPO);
  return fs.existsSync(cand) ? cand : null;
}

// A Cosmopolitan APE engine starts with the DOS 'MZ' magic and cannot be
// execve'd on non-Windows hosts — it must run via the ENOEXEC shell trampoline
// (`/bin/sh -c '"$@"' sh <ape> …`). Detect it so the agentic harness can drive a
// cosmo engine the same way e2e-pty.cjs's apeCmd() drives the interactive one.
function isApeFile(bin) {
  try {
    const fd = fs.openSync(bin, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b[0] === 0x4d && b[1] === 0x5a; // 'MZ'
  } catch { return false; }
}

// Build the [command, argv] to spawn the engine, APE-aware. For a normal Mach-O/
// ELF binary this is just [tjs, args]; for an APE it wraps in the /bin/sh
// trampoline. Behavior-neutral for non-APE engines (the common case).
function engineSpawn(args) {
  const tjs = tjsPath();
  if (!tjs) throw new Error('no tjs binary (gate with skipUnlessTjs first)');
  if (isApeFile(tjs)) return ['/bin/sh', ['-c', '"$@"', 'sh', tjs, ...args]];
  return [tjs, args];
}

function runLoader(entry, args = [], opts = {}) {
  const [cmd, argv] = engineSpawn(['run', LOADER, entry, ...args]);
  const r = spawnSync(cmd, argv, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
    timeout: opts.timeout || 30000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function skipUnlessTjs(t) {
  if (!tjsPath()) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs); run scripts/build-tjs.mjs'); return true; }
  return false;
}

module.exports = { tjsPath, runLoader, skipUnlessTjs, isApeFile, engineSpawn, REPO, LOADER };

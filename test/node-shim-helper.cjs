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

function runLoader(entry, args = [], opts = {}) {
  const tjs = tjsPath();
  if (!tjs) throw new Error('no tjs binary (gate with skipUnlessTjs first)');
  const r = spawnSync(tjs, ['run', LOADER, entry, ...args], {
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

module.exports = { tjsPath, runLoader, skipUnlessTjs, REPO, LOADER };

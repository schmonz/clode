'use strict';
// build-scratch — the ONE place a build path comes from.
//
// Why this exists: the good defaults already existed (the txiki vendor moved to
// ~/.cache/clode, cmake intermediates to TMPDIR, every fuse scratch dir to an
// os.tmpdir() mkdtemp) and CI overrode them straight back into the checkout —
// see .github/actions/build-leg/action.yml, which pointed CLODE_TJS_VENDOR and
// CLODE_TJS_OUT at "$PWD/.matrix/...". A default protects only whoever does not
// touch it. This module makes the in-tree path unrepresentable instead.
//
// Pure node stdlib; fs/env/spawn injected for testability.
const realFs = require('node:fs');
const realCp = require('node:child_process');
const path = require('node:path');

class BuildScratchError extends Error {
  constructor(msg) { super(msg); this.name = 'BuildScratchError'; this.code = 'CLODE_BUILD_SCRATCH'; }
}

// The marker is deliberately a CONJUNCTION. Any single file would misfire: plenty
// of projects have a VERSION or a package.json, and keying on .git would refuse to
// build inside ANY repo — including a user's, which must keep working.
function isCheckoutRoot(dir, fsm = realFs) {
  try {
    if (!fsm.existsSync(path.join(dir, 'libexec', 'clode-fuse.cjs'))) return false;
    if (!fsm.existsSync(path.join(dir, 'VERSION'))) return false;
    const pkg = JSON.parse(fsm.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'clode';
  } catch { return false; }
}

function findCheckoutRoot(startPath, fsm = realFs) {
  let dir;
  try { dir = fsm.realpathSync(startPath); }
  catch { dir = path.resolve(startPath); }   // may not exist yet: a path we are ABOUT to create
  for (;;) {
    if (isCheckoutRoot(dir, fsm)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function isInsideCheckout(p, fsm = realFs) { return findCheckoutRoot(p, fsm) !== null; }

// Prove a directory is exec-able by EXECUTING something from it. Mount flags are
// not portable and not readable from JS, and the failure we care about (a noexec
// /tmp on a hardened guest, exit 127 mid-build) is only observable by trying.
function probeExec(dir, opts) {
  // Normalize opts: handle both undefined and null. Destructuring = {} only guards
  // undefined, not null, so explicit normalization ensures we never throw on bad input.
  const { fsm = realFs, spawnSync = realCp.spawnSync, platform = process.platform } = opts || {};

  let marker;
  try {
    // Move marker computation inside try so a bad `dir` is caught and returned, not thrown.
    marker = path.join(dir, `.clode-exec-probe-${process.pid}`);
    fsm.mkdirSync(dir, { recursive: true });

    // Different probe formats for different platforms, same exec-ability contract.
    let content;
    let ext;
    if (platform === 'win32') {
      // Windows: .cmd file with exit /b 42 (removes the divergence and uses identical contract)
      content = '@echo off\nexit /b 42\n';
      ext = '.cmd';
      marker = path.join(dir, `.clode-exec-probe-${process.pid}${ext}`);
    } else {
      // POSIX: shell script with exit 42
      content = '#!/bin/sh\nexit 42\n';
      ext = '';
    }

    fsm.writeFileSync(marker, content);
    if (platform !== 'win32') {
      // chmod only needed on POSIX; Windows .cmd is executable by default.
      fsm.chmodSync(marker, 0o755);
    }
  } catch (e) {
    try { fsm.rmSync(marker, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, reason: `cannot write a probe file: ${e && e.message}` };
  }

  let res;
  try { res = spawnSync(marker, [], { stdio: 'pipe' }); }
  catch (e) { res = { status: null, error: e }; }
  finally { try { fsm.rmSync(marker, { force: true }); } catch { /* best effort */ } }

  // 42 is arbitrary but SPECIFIC: a plain 0 would also be returned by a shell/cmd that
  // silently did nothing, so the exact status is what proves our script really ran.
  if (res && res.status === 42) return { ok: true, reason: 'exec probe ran and returned 42' };
  const detail = res && res.error ? res.error.message
    : `exit ${res && res.status}${res && res.stderr ? `: ${String(res.stderr).trim()}` : ''}`;
  return { ok: false, reason: `exec probe did not run (${detail})` };
}

module.exports = { BuildScratchError, isCheckoutRoot, findCheckoutRoot, isInsideCheckout, probeExec };

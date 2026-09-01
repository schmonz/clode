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
const os = require('node:os');

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
    // win32 needs a .cmd extension for the exec-ability contract below; POSIX needs none.
    marker = path.join(dir, `.clode-exec-probe-${process.pid}${platform === 'win32' ? '.cmd' : ''}`);
    fsm.mkdirSync(dir, { recursive: true });

    // Different probe formats for different platforms, same exec-ability contract.
    let content;
    if (platform === 'win32') {
      // Windows: .cmd file with exit /b 42 (removes the divergence and uses identical contract)
      content = '@echo off\nexit /b 42\n';
    } else {
      // POSIX: shell script with exit 42
      content = '#!/bin/sh\nexit 42\n';
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
  try {
    // Windows (.cmd) requires explicit shell invocation since CVE-2024-27980 (Node 18.20.2+).
    // Spawn the interpreter directly with the script as an argument to avoid shell parsing
    // of the marker path (which may contain spaces or shell metacharacters).
    if (platform === 'win32') {
      res = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', marker], { stdio: 'pipe' });
    } else {
      res = spawnSync(marker, [], { stdio: 'pipe' });
    }
  } catch (e) { res = { status: null, error: e }; }
  finally { try { fsm.rmSync(marker, { force: true }); } catch { /* best effort */ } }

  // 42 is arbitrary but SPECIFIC: a plain 0 would also be returned by a shell/cmd that
  // silently did nothing, so the exact status is what proves our script really ran.
  if (res && res.status === 42) return { ok: true, reason: 'exec probe ran and returned 42' };
  const detail = res && res.error ? res.error.message
    : `exit ${res && res.status}${res && res.stderr ? `: ${String(res.stderr).trim()}` : ''}`;
  return { ok: false, reason: `exec probe did not run (${detail})` };
}

// Ordered exactly as the phase-1 spec states. cacheBase last and HOME-derived is
// the hardened-guest fallback: it is the candidate that has to work when /tmp is
// noexec, now that the checkout is not an option.
function scratchCandidates(env = process.env) {
  const home = env.HOME || os.homedir();
  const cacheBase = env.XDG_CACHE_HOME || path.join(home, '.cache');
  const out = [];
  if (env.CLODE_BUILD_SCRATCH) out.push({ name: 'CLODE_BUILD_SCRATCH', dir: env.CLODE_BUILD_SCRATCH });
  if (env.TMPDIR) out.push({ name: 'TMPDIR', dir: env.TMPDIR });
  out.push({ name: 'os.tmpdir()', dir: os.tmpdir() });
  out.push({ name: 'cacheBase', dir: path.join(cacheBase, 'clode', 'scratch') });
  return out;
}

// scratchRoot's only real cost is probeExec's spawnSync — measured at ~660ms on this
// box, and buildPath() (which calls this on EVERY invocation) sits behind 298
// skipUnlessTjs sites plus every runLoader/engineSpawn call in the node-shim suite,
// so an unmemoized resolution reproduces exactly the sin this whole phase exists to
// fix (an in-tree default silently corrupting perf measurements) in a new place:
// `node --test test/node-shim-core.test.cjs` went 20.1s -> 1.5s once memoized
// (CLODE_TJS-bypass timing, same results, confirming the redundant re-resolution
// was the entire cost).
//
// Keyed on the CANDIDATE LIST (scratchCandidates(env), not raw env) so a changed
// CLODE_BUILD_SCRATCH/TMPDIR still re-resolves — and on the ACTUAL fsm/probe used,
// via a nested Map on object identity (not stringified — two different closures can
// share source text) — so an injected stub (every test that passes one) gets its
// own cache slot and never serves, or is served, a stale entry across a different
// fsm/probe. The real, default fsm/probe are themselves stable module-level
// singletons, so the hot production path (no injection at all) memoizes exactly as
// intended. A THROWN resolution is deliberately never cached: a transient
// condition (a remounted noexec /tmp, say) must be retried, not remembered forever.
const scratchRootCache = new Map(); // fsm -> Map(probe -> Map(candidateKey -> dir))

function scratchRoot(env = process.env, { fsm = realFs, probe = probeExec, platform = process.platform } = {}) {
  const candidateKey = scratchCandidates(env).map((c) => `${c.name}=${c.dir}`).join('\n') + `\n${platform}`;
  let byProbe = scratchRootCache.get(fsm);
  if (!byProbe) { byProbe = new Map(); scratchRootCache.set(fsm, byProbe); }
  let byCandidates = byProbe.get(probe);
  if (!byCandidates) { byCandidates = new Map(); byProbe.set(probe, byCandidates); }
  if (byCandidates.has(candidateKey)) return byCandidates.get(candidateKey);

  const tried = [];
  for (const c of scratchCandidates(env)) {
    if (isInsideCheckout(c.dir, fsm)) {
      tried.push(`  ${c.name}=${c.dir}\n    rejected: inside a clode source checkout`);
      continue;
    }
    const r = probe(c.dir, { fsm, platform });
    if (r.ok) { byCandidates.set(candidateKey, c.dir); return c.dir; }
    tried.push(`  ${c.name}=${c.dir}\n    rejected: ${r.reason}`);
  }
  throw new BuildScratchError(
    'no usable build scratch directory. A build must not write inside the checkout,\n'
    + 'so every candidate below was required to be outside it AND exec-able:\n'
    + tried.join('\n')
    + '\nSet CLODE_BUILD_SCRATCH to a writable, exec-able directory outside the checkout.');
}

function buildPath(...segments) {
  let opts = {};
  if (segments.length && typeof segments[segments.length - 1] === 'object' && segments[segments.length - 1] !== null) {
    opts = segments.pop();
  }
  const root = scratchRoot(opts.env || process.env, opts);
  const p = path.join(root, ...segments);
  // Belt and braces: scratchRoot already refused in-checkout roots, but a caller
  // can pass '..' segments, and this is the function everything else goes through.
  if (isInsideCheckout(p, opts.fsm || realFs)) {
    throw new BuildScratchError(`refusing a build path inside a clode source checkout: ${p}`);
  }
  return p;
}

module.exports = {
  BuildScratchError, isCheckoutRoot, findCheckoutRoot, isInsideCheckout, probeExec,
  scratchCandidates, scratchRoot, buildPath,
};

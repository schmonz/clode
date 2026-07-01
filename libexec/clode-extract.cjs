'use strict';
// clode-extract — JS port of bin/clode's extract_if_needed: the extract-on-change
// caching orchestration. Behavior-for-behavior with the sh launcher, but runs the
// extractor IN-PROCESS (require of the sibling extract-claude-js.cjs) instead of
// spawning it. Pure Node stdlib + sibling .cjs requires; runs before any ext-deps
// are ensured.
//
// The cached cli.cjs is a function of BOTH the provider binary (captured by the
// cache KEY / cacheDir) AND the extractor logic that patches it. The key only
// captures the binary, so we fingerprint the extractor too (.extractor-sig) and
// re-extract when it changes — otherwise an extract-claude-js edit never reaches
// existing caches until the binary moves. The bun-shim is handled separately: a
// cache hit still refreshes the cached shim if the installed source differs, so a
// shim fix reaches existing per-version caches without waiting for a re-extract.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sigOf } = require('./clode-resolve.cjs');
const { extractToFile } = require('./extract-claude-js.cjs');

// `[ -f "$p" ]`: exists AND is a regular file (any stat error -> false).
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// `[ "$(cat "$p" 2>/dev/null)" = ... ]`: command substitution strips trailing
// newlines; a missing file yields "".
function readSig(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

// `cmp -s a b`: byte-identical? A missing/unreadable file counts as different.
function filesEqual(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Port of run_quiet around the (in-process) extractor: when verbose, let its
// stderr stream live; otherwise buffer stdout+stderr and swallow on success,
// resurfacing it only on failure (keeping "see error above" honest). Restores the
// original writers even if fn throws.
function runQuiet(verbose, fn) {
  if (verbose) return fn();
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let buf = '';
  const cap = (chunk) => { buf += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); return true; };
  process.stderr.write = cap;
  process.stdout.write = cap;
  try {
    const r = fn();
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    return r;
  } catch (e) {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    if (buf) origErr(buf);
    throw e;
  }
}

// Extract-on-first-use, cached per key. Mirrors extract_if_needed exactly:
//  - CACHE HIT when cli.cjs AND bun-shim.cjs exist AND .extractor-sig matches the
//    current extractor sig: still refresh the cached shim if the installed source
//    differs, then return.
//  - CACHE MISS: log (first-extract vs extractor-changed), run the extractor
//    in-process to (re)write cli.cjs, `node --check` it, copy the shim, write the
//    sig. Any extraction/verify/check problem removes the partial cli.cjs and fails
//    loudly (throws), matching the sh's rm + exit 1.
//
// opts: { bin, cacheDir, libexec, verbose=false, node=process.execPath, key,
//         log } — `key` defaults to basename(cacheDir) (the sh KEY, since
//         CACHE=CACHE_ROOT/KEY); `log` is the clode_log sink (defaults to stderr).
function extractIfNeeded(opts) {
  const {
    bin, cacheDir, libexec,
    verbose = false,
    node = process.execPath,
  } = opts;
  const key = opts.key !== undefined ? opts.key : path.basename(cacheDir);
  const emit = opts.log || ((m) => process.stderr.write(m + '\n'));
  const clodeLog = (m) => { if (verbose) emit(m); };

  const extractorSig = sigOf(path.join(libexec, 'extract-claude-js.cjs'));
  const cliPath = path.join(cacheDir, 'cli.cjs');
  const cacheShim = path.join(cacheDir, 'bun-shim.cjs');
  // The bun-shim source is libexec/bun-shim.cjs in the npm/source layout; under a
  // SEA the caller passes the materialized (embedded-asset) shim instead.
  const srcShim = opts.bunShimSrc || path.join(libexec, 'bun-shim.cjs');
  const sigPath = path.join(cacheDir, '.extractor-sig');

  if (isFile(cliPath) && isFile(cacheShim) && readSig(sigPath) === extractorSig) {
    // Cache hit on the bundle. Refresh the cached shim if the installed source
    // differs, so a shim fix reaches existing per-version caches without waiting
    // for a provider update to trigger a re-extract.
    if (!filesEqual(srcShim, cacheShim)) {
      fs.copyFileSync(srcShim, cacheShim);
      clodeLog(`clode: refreshed cached bun-shim for ${key}`);
    }
    return;
  }

  if (isFile(cliPath)) {
    clodeLog(`clode: extractor changed; re-extracting JS for ${key}...`);
  } else {
    clodeLog(`clode: extracting JS for ${key}...`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    runQuiet(verbose, () => extractToFile(bin, cliPath));
  } catch (e) {
    try { fs.rmSync(cliPath); } catch { /* ignore */ }
    process.stderr.write('clode: extraction failed (see error above); not caching.\n');
    throw e;
  }

  const chk = spawnSync(node, ['--check', cliPath], { encoding: 'utf8' });
  if (chk.status !== 0) {
    try { fs.rmSync(cliPath); } catch { /* ignore */ }
    if (chk.stderr) process.stderr.write(chk.stderr);
    process.stderr.write("clode: extracted JS failed 'node --check'; not caching.\n");
    throw new Error("extracted JS failed 'node --check'");
  }

  fs.copyFileSync(srcShim, cacheShim);
  fs.writeFileSync(sigPath, extractorSig + '\n');
}

module.exports = { extractIfNeeded };

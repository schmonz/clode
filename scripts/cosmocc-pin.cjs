#!/usr/bin/env node
'use strict';
// The cosmocc toolchain pin, and the ONE way it is fetched: an ordered mirror list,
// every mirror verified against the SAME pinned sha256.
//
// WHY A MIRROR LIST. Run 44460009323 (2026-11-19): the cosmo leg's only source,
// https://cosmo.zip/pub/cosmocc/, refused the connection ("Network request failed:
// Unable to connect") and it timed out from a dev box the same day. The identical
// asset (441,763,966 bytes, same sha256) is published by upstream itself as a GitHub
// release asset of jart/cosmopolitan. One unreachable host was a red leg.
//
// WHY THE ORDER. github.com first: it is upstream's own release asset, and it is
// served by the infrastructure every CI run already depends on (checkout, the
// templates pack, the bootstrap engine) — a runner that cannot reach it is red for
// other reasons anyway. cosmo.zip second: upstream's canonical download page, kept
// as the fallback rather than dropped.
//
// WHAT A MIRROR IS TRUSTED FOR: nothing. A mirror only supplies bytes; the pinned
// sha256 decides. A mismatch is logged by mirror name and the next one is tried; the
// final name is only ever written after verification, so a cache can never capture
// an unverified zip. All mirrors failing is a refusal that names every attempt.
//
// The CI cache key is derived from this file (`node scripts/cosmocc-pin.cjs
// cache-key`), not spelled in YAML, so a pin bump cannot restore the old toolchain.

const fs = require('node:fs');

const COSMOCC_VERSION = '4.0.2';
const COSMOCC_SHA256 = '85b8c37a406d862e656ad4ec14be9f6ce474c1b436b9615e91a55208aced3f44';
const COSMOCC_ZIP = `cosmocc-${COSMOCC_VERSION}.zip`;
const COSMOCC_MIRRORS = Object.freeze([
  Object.freeze({ name: 'github-release', url: `https://github.com/jart/cosmopolitan/releases/download/${COSMOCC_VERSION}/${COSMOCC_ZIP}` }),
  Object.freeze({ name: 'cosmo.zip', url: `https://cosmo.zip/pub/cosmocc/${COSMOCC_ZIP}` }),
]);

// The actions/cache key for the cached zip: version AND sha, so neither a version bump
// nor a re-pin of the same version can be satisfied by the old bytes.
function cacheKey() {
  return `cosmocc-${COSMOCC_VERSION}-${COSMOCC_SHA256.slice(0, 16)}`;
}

// The directory the verified zip is extracted into, under <cache>/cosmocc/. Keyed by the
// sha as well as the version: the extracted tree is reused without re-hashing, so its
// name is what ties it to the verified zip it came from.
function extractDirName() {
  return `${COSMOCC_VERSION}-${COSMOCC_SHA256.slice(0, 16)}`;
}

// Fetch `dest` from the first mirror whose bytes hash to `sha256`. Injected
// downloadFile/sha256Of (libexec/clode-net.cjs's in production) keep this testable
// with file:// mirrors. Returns the name of the mirror that supplied the bytes.
async function fetchVerified({ mirrors, sha256, dest, downloadFile, sha256Of, log = console.log }) {
  if (!Array.isArray(mirrors) || mirrors.length === 0) throw new Error('cosmo: no cosmocc mirrors configured');
  const part = `${dest}.part`;
  const failures = [];
  for (let i = 0; i < mirrors.length; i++) {
    const m = mirrors[i];
    if (i > 0) log(`cosmo: falling back to mirror ${m.name} (${failures[failures.length - 1]})`);
    log(`cosmo: downloading ${m.url} via mirror ${m.name} ...`);
    fs.rmSync(part, { force: true });
    try {
      await downloadFile(m.url, part);
    } catch (e) {
      fs.rmSync(part, { force: true });
      failures.push(`${m.name}: ${(e && e.message) || e}`);
      continue;
    }
    const got = sha256Of(part);
    if (got !== sha256) {
      fs.rmSync(part, { force: true });
      failures.push(`${m.name}: sha256 mismatch (expected ${sha256}, got ${got})`);
      continue;
    }
    fs.renameSync(part, dest);
    log(`cosmo: ${m.name} verified (sha256 ${sha256})`);
    return m.name;
  }
  throw new Error(`cosmo: every cosmocc mirror failed — refusing to build without a verified toolchain:\n  ${failures.join('\n  ')}`);
}

module.exports = { COSMOCC_VERSION, COSMOCC_SHA256, COSMOCC_ZIP, COSMOCC_MIRRORS, cacheKey, extractDirName, fetchVerified };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'cache-key') process.stdout.write(`${cacheKey()}\n`);
  else if (cmd === 'zip') process.stdout.write(`${COSMOCC_ZIP}\n`);
  else { process.stderr.write('usage: cosmocc-pin.cjs cache-key|zip\n'); process.exit(2); }
}

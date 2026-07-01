#!/usr/bin/env node
'use strict';
// Build the clode Node SEA (host platform, embedded = the node running this script).
// `--bundle-only` stops after esbuild (Task 1); the full pipeline (deps asset,
// sea-config, blob, postject, and macOS re-sign) is appended in Task 5.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'build', 'sea');
fs.mkdirSync(OUT, { recursive: true });

// clode's version lives in the VERSION file at the repo root. The esbuilt bundle's
// __dirname is build/sea (not the package root), so the runtime file-read in
// clode-main can't find it — inject it at build time as a define. clode-main prefers
// the VERSION file when present (npm/source layout) and falls back to this constant
// (bundle/SEA), so both paths report the real version.
function repoVersion() {
  try { return fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '') || 'dev'; }
  catch { return 'dev'; }
}

function esbuildBundle() {
  const esbuild = path.join(REPO, 'build', 'node_modules', '.bin', 'esbuild');
  const bundle = path.join(OUT, 'clode-main.bundle.cjs');
  execFileSync(esbuild, [
    path.join(REPO, 'libexec', 'clode-main.cjs'),
    '--bundle', '--platform=node', '--format=cjs', '--target=node24',
    `--define:__CLODE_BUNDLE_VERSION__=${JSON.stringify(repoVersion())}`,
    `--outfile=${bundle}`,
  ], { stdio: 'inherit' });
  return bundle;
}

const bundleOnly = process.argv.includes('--bundle-only');
const bundle = esbuildBundle();
console.error(`esbuild → ${bundle}`);
if (bundleOnly) process.exit(0);
// (Task 5 appends: deps.tar, sea-config, blob, postject, [macOS] resign.)

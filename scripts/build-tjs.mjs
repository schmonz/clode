#!/usr/bin/env node
// Build the patched tjs binary clode's node-shim targets.
// Sources: pinned checkouts under spike/quickjs/vendor/ (cloned if absent,
// tags from spike/quickjs/PINS.md). Patches: spike/quickjs/patches/*.patch
// applied idempotently (git apply --check first). Output: build/tjs/tjs.
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const vendor = path.join(repo, 'spike/quickjs/vendor');
const patches = path.join(repo, 'spike/quickjs/patches');
const outDir = path.join(repo, 'build/tjs');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const runOut = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

function pin(component) {
  const line = fs.readFileSync(path.join(repo, 'spike/quickjs/PINS.md'), 'utf8')
    .split('\n').find((l) => l.split(/\s+/)[0] === component);
  if (!line) throw new Error(`no PIN for ${component}`);
  return line.split(/\s+/)[1];
}

function ensureCheckout(name, url) {
  const dir = path.join(vendor, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(vendor, { recursive: true });
    run('git', ['clone', '--recurse-submodules', '--depth', '1', '--branch', pin(name), url, dir]);
  }
  return dir;
}

function applyPatches(dir, prefix) {
  for (const p of fs.readdirSync(patches).filter((f) => f.startsWith(prefix) && f.endsWith('.patch'))) {
    const abs = path.join(patches, p);
    try {
      execFileSync('git', ['-C', dir, 'apply', '--check', abs], { stdio: 'pipe' });
    } catch {
      console.log(`patch ${p}: already applied or conflicting — verifying reverse-applies`);
      execFileSync('git', ['-C', dir, 'apply', '--check', '--reverse', abs], { stdio: 'pipe' });
      continue; // reverse-check passed => already applied
    }
    run('git', ['-C', dir, 'apply', abs]);
    console.log(`patch ${p}: applied`);
  }
}

const tjsDir = ensureCheckout('txiki.js', 'https://github.com/saghul/txiki.js.git');
applyPatches(tjsDir, 'txiki-');

const jobs = String(cpus().length);
run('cmake', ['-S', tjsDir, '-B', path.join(tjsDir, 'build'), '-DCMAKE_BUILD_TYPE=Release']);
run('cmake', ['--build', path.join(tjsDir, 'build'), '-j', jobs]);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(tjsDir, 'build/tjs'), path.join(outDir, 'tjs'));
fs.chmodSync(path.join(outDir, 'tjs'), 0o755);

const smoke = runOut(path.join(outDir, 'tjs'),
  ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")']);
if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
console.log(`built ${path.join(outDir, 'tjs')} (${smoke})`);

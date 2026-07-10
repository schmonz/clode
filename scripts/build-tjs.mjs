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

// Fallback idempotency proof for patches whose reverse-check fails because a
// LATER patch edited overlapping context (sync-fs vs sync-spawn — the PINS.md
// build caveat): every line the patch ADDS must be present verbatim in its
// target file. Weaker than reverse-apply but still loud on a missing patch.
function addedLinesPresent(dir, patchAbs) {
  const text = fs.readFileSync(patchAbs, 'utf8');
  let target = null;
  const wanted = new Map(); // file -> [added lines]
  for (const line of text.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) { target = m[1]; continue; }
    if (target && line.startsWith('+') && !line.startsWith('++')) {
      const content = line.slice(1);
      if (content.trim() === '') continue;
      if (!wanted.has(target)) wanted.set(target, []);
      wanted.get(target).push(content);
    }
  }
  for (const [file, lines] of wanted) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return `${file}: missing`;
    const body = fs.readFileSync(p, 'utf8').split('\n');
    const have = new Set(body);
    for (const l of lines) if (!have.has(l)) return `${file}: missing line ${JSON.stringify(l)}`;
  }
  return null; // all added content present
}

function applyPatches(dir, prefix) {
  for (const p of fs.readdirSync(patches).filter((f) => f.startsWith(prefix) && f.endsWith('.patch'))) {
    const abs = path.join(patches, p);
    try {
      execFileSync('git', ['-C', dir, 'apply', '--check', abs], { stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['-C', dir, 'apply', '--check', '--reverse', abs], { stdio: 'pipe' });
        console.log(`patch ${p}: already applied (reverse-check)`);
      } catch {
        const missing = addedLinesPresent(dir, abs);
        if (missing) throw new Error(`patch ${p}: neither applies nor verifies as applied (${missing})`);
        console.log(`patch ${p}: already applied (content-presence; overlapping-context caveat)`);
      }
      continue;
    }
    run('git', ['-C', dir, 'apply', abs]);
    console.log(`patch ${p}: applied`);
  }
}

const tjsDir = ensureCheckout('txiki.js', 'https://github.com/saghul/txiki.js.git');
applyPatches(tjsDir, 'txiki-');

const jobs = String(cpus().length);
// -DTJS_USE_ADA=OFF: our recipe selects the plain-C wurl URL parser (the
// ada-ectomy). The upstream-facing patch keeps the option's default ON;
// only OUR build flips it. Kills the C++20 toolchain requirement and libc++.
run('cmake', ['-S', tjsDir, '-B', path.join(tjsDir, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF']);
run('cmake', ['--build', path.join(tjsDir, 'build'), '-j', jobs]);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(tjsDir, 'build/tjs'), path.join(outDir, 'tjs'));
fs.chmodSync(path.join(outDir, 'tjs'), 0o755);

const smoke = runOut(path.join(outDir, 'tjs'),
  ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")']);
if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
console.log(`built ${path.join(outDir, 'tjs')} (${smoke})`);

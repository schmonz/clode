#!/usr/bin/env node
// Build the patched tjs binary clode's node-shim targets.
// Sources: pinned checkouts under spike/quickjs/vendor/ (cloned if absent,
// tags from spike/quickjs/PINS.md; a fresh clone is sha-verified against the
// PIN). Patches: spike/quickjs/patches/*.patch applied idempotently
// (git apply --check first). Output: build/tjs/tjs.
//
// Env knobs (all optional; defaults preserve the local flow exactly):
//   CLODE_TJS_VENDOR  checkout parent dir (CI uses a scratch dir so the tree is
//                     constructed from committed material alone: pinned clone +
//                     patches — vendor/ is uncommitted scratch locally)
//   CLODE_TJS_OUT     output dir for the tjs binary (default build/tjs)
//   CLODE_TJS_STATIC  =1: fully-static link (musl legs) — -static plus
//                     BUILD_WITH_FFI=OFF (libffi is the ONLY external dep and
//                     tjs:ffi's dlopen is useless in a static binary; nothing
//                     shipped imports it — bun:ffi is a throw-on-use stub)
//
// Phases (CI splits them so a qemu-user guest only pays for the C build):
//   --source-only  stop after checkout + sha-verify + patches
//   --build-only   skip checkout/patches (tree must exist), cmake + smoke only
//   (default: both — the local flow, unchanged)
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const sourceOnly = process.argv.includes('--source-only');
const buildOnly = process.argv.includes('--build-only');
if (sourceOnly && buildOnly) throw new Error('pick one of --source-only / --build-only');
const vendor = process.env.CLODE_TJS_VENDOR || path.join(repo, 'spike/quickjs/vendor');
const patches = path.join(repo, 'spike/quickjs/patches');
const outDir = process.env.CLODE_TJS_OUT || path.join(repo, 'build/tjs');
const wantStatic = process.env.CLODE_TJS_STATIC === '1';
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const runOut = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

function pinFields(component) {
  const line = fs.readFileSync(path.join(repo, 'spike/quickjs/PINS.md'), 'utf8')
    .split('\n').find((l) => l.split(/\s+/)[0] === component);
  if (!line) throw new Error(`no PIN for ${component}`);
  return line.split(/\s+/);
}
const pin = (component) => pinFields(component)[1];
const pinSha = (component) => pinFields(component)[2];

function ensureCheckout(name, url) {
  const dir = path.join(vendor, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(vendor, { recursive: true });
    run('git', ['clone', '--recurse-submodules', '--depth', '1', '--branch', pin(name), url, dir]);
  }
  // The tag must still mean what PINS.md recorded (a moved tag or a stale
  // local checkout fails loudly — provenance gate for the from-pins CI flow).
  const head = runOut('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (head !== pinSha(name)) {
    throw new Error(`${name}: checkout HEAD ${head} != PINS.md sha ${pinSha(name)} (tag ${pin(name)})`);
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

// THE documented application order (from-pins flow, proven on a pristine
// v26.6.0 tree 2026-07-09). Not alphabetical: spawn-inherit-fd was diffed
// against a tree that already carried spawn-fail-uaf, so its mod_process.c
// hunks SUBSUME the uaf fix — inherit-fd must go first, after which uaf
// verifies as already-applied (content-presence fallback below). Every
// txiki-*.patch in patches/ MUST appear here; a new patch without a
// documented position fails loudly.
const TXIKI_PATCH_ORDER = [
  'txiki-default-stack-size.patch',
  'txiki-netbsd-portability.patch',
  'txiki-no-origin-header.patch',
  'txiki-spawn-inherit-fd.patch',   // before spawn-fail-uaf (subsumes it)
  'txiki-spawn-fail-uaf.patch',
  'txiki-stream-write-sync-number.patch',
  'txiki-sync-fs.patch',
  'txiki-sync-spawn.patch',
  'txiki-wurl-url.patch',
];

function orderedPatches(prefix) {
  const present = fs.readdirSync(patches).filter((f) => f.startsWith(prefix) && f.endsWith('.patch'));
  if (prefix === 'txiki-') {
    const undocumented = present.filter((f) => !TXIKI_PATCH_ORDER.includes(f));
    if (undocumented.length) throw new Error(`patches without a documented order: ${undocumented.join(', ')} (add to TXIKI_PATCH_ORDER)`);
    return TXIKI_PATCH_ORDER.filter((f) => present.includes(f));
  }
  return present;
}

function applyPatches(dir, prefix) {
  for (const p of orderedPatches(prefix)) {
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

let tjsDir;
if (buildOnly) {
  // The patched tree was constructed by a prior --source-only run (possibly on
  // a different host — CI builds inside a chroot the host prepared for).
  tjsDir = path.join(vendor, 'txiki.js');
  if (!fs.existsSync(path.join(tjsDir, 'CMakeLists.txt'))) {
    throw new Error(`--build-only: no txiki.js tree at ${tjsDir} (run --source-only first, or set CLODE_TJS_VENDOR)`);
  }
} else {
  tjsDir = ensureCheckout('txiki.js', 'https://github.com/saghul/txiki.js.git');
  applyPatches(tjsDir, 'txiki-');
}
if (sourceOnly) {
  console.log(`source tree ready: ${tjsDir}`);
  process.exit(0);
}

const jobs = String(cpus().length);
// -DTJS_USE_ADA=OFF: our recipe selects the plain-C wurl URL parser (the
// ada-ectomy). The upstream-facing patch keeps the option's default ON;
// only OUR build flips it. Kills the C++20 toolchain requirement and libc++.
const cmakeArgs = ['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF'];
if (wantStatic) {
  cmakeArgs.push('-DBUILD_WITH_FFI=OFF', '-DCMAKE_EXE_LINKER_FLAGS=-static');
}
run('cmake', ['-S', tjsDir, '-B', path.join(tjsDir, 'build'), ...cmakeArgs]);
run('cmake', ['--build', path.join(tjsDir, 'build'), '-j', jobs]);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(tjsDir, 'build/tjs'), path.join(outDir, 'tjs'));
fs.chmodSync(path.join(outDir, 'tjs'), 0o755);

const smoke = runOut(path.join(outDir, 'tjs'),
  ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")']);
if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
console.log(`built ${path.join(outDir, 'tjs')} (${smoke})`);

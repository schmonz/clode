#!/usr/bin/env node
'use strict';
// Build the clode Node SEA (host platform, embedded = the node running this script).
// `--bundle-only` stops after esbuild (Task 1); the full pipeline (deps asset,
// sea-config, blob, postject, and macOS re-sign) is appended in Task 5.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { platformTag, seaBin } = require('./platform-tag.cjs');

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// All build artifacts (toolchain node_modules, bundle, deps.tar, blob, and the final
// binary) live under a per-platform tag dir so a shared/NFS `build/` tree can host
// mutually-incompatible builds (different OS/OS-version/arch/node) without collision.
const TOOLCHAIN = path.join(REPO, 'build', platformTag());
const OUT = TOOLCHAIN;
fs.mkdirSync(OUT, { recursive: true });

// npm is a .cmd on Windows; execFileSync needs a shell for it. (The npm args below are
// all static flags — no user-controlled paths as args — so shell:true is injection-safe;
// cwd is passed as an option, not an arg.)
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPM_OPTS = process.platform === 'win32' ? { shell: true } : {};

// Run a toolchain CLI (esbuild/postject) via its node_modules/.bin shim. On POSIX the
// shim is directly executable — esbuild's is the native binary (post-install), postject's
// is a #!node script — so execFileSync runs it as-is. On Windows the runnable shim is a
// .cmd, which execFileSync can only launch through a shell. (Build paths live under
// build/<tag> and have no spaces in practice; if a repo path with spaces bites on Windows,
// quote the args here.)
function runBin(name, args, opts = {}) {
  const shim = path.join(TOOLCHAIN, 'node_modules', '.bin', name);
  if (process.platform === 'win32') {
    execFileSync(`${shim}.cmd`, args, { ...opts, shell: true });
  } else {
    execFileSync(shim, args, opts);
  }
}

// Provision the build-only toolchain (esbuild, postject) INTO the per-tag dir, so each
// host installs its own native binaries side by side instead of overwriting a shared
// build/node_modules. Idempotent: skips the install once the .bin shims are present.
function ensureToolchain() {
  const bin = (name) => path.join(TOOLCHAIN, 'node_modules', '.bin', name);
  if (fs.existsSync(bin('esbuild')) && fs.existsSync(bin('postject'))) return;
  // npm --prefix needs the manifest in the prefix dir; the committed source of truth
  // is build/package.json (build-only devDeps, kept out of the repo-root node_modules).
  fs.copyFileSync(path.join(REPO, 'build', 'package.json'), path.join(TOOLCHAIN, 'package.json'));
  // Prefer a reproducible, pinned install: copy the committed lockfile and `npm ci`.
  // Fall back to `npm install` only when no lockfile is present.
  const lock = path.join(REPO, 'build', 'package-lock.json');
  const cmd = fs.existsSync(lock)
    ? (fs.copyFileSync(lock, path.join(TOOLCHAIN, 'package-lock.json')), ['ci'])
    : ['install'];
  console.error(`toolchain: installing esbuild+postject into ${path.relative(REPO, TOOLCHAIN)}`);
  // cwd: TOOLCHAIN (not --prefix) so npm reads this manifest as the root — see stageDeps.
  execFileSync(NPM, [cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: TOOLCHAIN, ...NPM_OPTS });
}

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
  const bundle = path.join(OUT, 'clode-main.bundle.cjs');
  runBin('esbuild', [
    path.join(REPO, 'libexec', 'clode-main.cjs'),
    '--bundle', '--platform=node', '--format=cjs', '--target=node24',
    `--define:__CLODE_BUNDLE_VERSION__=${JSON.stringify(repoVersion())}`,
    `--outfile=${bundle}`,
  ], { stdio: 'inherit' });
  return bundle;
}

// Stage the shipped runtime deps (root package.json) and tar the resulting node_modules
// as the embedded deps asset. A sha256 of the tar is the sig materializeDeps keys the
// extraction cache on.
//
// Two things keep this fast and NFS-friendly:
//   1. Stage on LOCAL disk (os.tmpdir), never the (possibly NFS) build dir. npm writing
//      ~350 tiny node_modules files onto an NFS mount took ~5 min here; on local disk
//      it's sub-second. Only the single resulting tar is written back to the tag dir.
//   2. Cache on the lockfile hash: skip npm+tar entirely when the lockfile is unchanged.
//      This also keeps deps.sig STABLE across rebuilds (a fresh tar's mtimes would churn
//      the sig and needlessly bust every client's runtime extraction cache).
function stageDeps() {
  const tar = path.join(OUT, 'deps.tar');
  const sigFile = path.join(OUT, 'deps.sig');
  const lockHashFile = path.join(OUT, 'deps.lockhash');
  const lock = path.join(REPO, 'package-lock.json');
  const manifest = fs.existsSync(lock) ? lock : path.join(REPO, 'package.json');
  const lockHash = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
  if (fs.existsSync(tar) && fs.existsSync(sigFile) && fs.existsSync(lockHashFile)
      && fs.readFileSync(lockHashFile, 'utf8') === lockHash) {
    console.error('deps: reusing cached deps.tar (lockfile unchanged)');
    return { tar, sigFile };
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-deps-'));
  try {
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(staging, 'package.json'));
    // Prefer a reproducible install: copy the committed lockfile and `npm ci` (exact,
    // locked versions). Fall back to `npm install` only if no lockfile is present.
    const cmd = fs.existsSync(lock)
      ? (fs.copyFileSync(lock, path.join(staging, 'package-lock.json')), ['ci', '--omit=dev'])
      : ['install', '--omit=dev'];
    // Run npm IN the staging dir (cwd), not via --prefix: with --prefix, npm mis-derives
    // the root package name from the prefix's basename when cwd is a different package
    // (the repo root, also named "clode"), and `npm ci` then fails the lockfile sync check.
    execFileSync(NPM, [cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: staging, ...NPM_OPTS });
    execFileSync('tar', ['-cf', tar, '-C', staging, 'node_modules']);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const sig = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
  fs.writeFileSync(sigFile, sig);
  fs.writeFileSync(lockHashFile, lockHash);
  return { tar, sigFile };
}

function writeSeaConfig(bundle, tar, sigFile) {
  const cfg = {
    main: bundle,
    output: path.join(OUT, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,   // don't print node's SEA warning on every run
    // The libexec-shaped support files clode-sea materializes to disk at runtime, so
    // extractIfNeeded finds them (shim + extractor) exactly as in the npm/source tree.
    assets: {
      'deps.tar': tar,
      'deps.sig': sigFile,
      'bun-shim.cjs': path.join(REPO, 'libexec', 'bun-shim.cjs'),
      'extract-claude-js.cjs': path.join(REPO, 'libexec', 'extract-claude-js.cjs'),
    },
  };
  const p = path.join(OUT, 'sea-config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return { cfgPath: p, blob: cfg.output };
}

// Embed THIS node (the running interpreter) + the blob into a stand-alone binary.
// macOS needs an unsign/re-sign dance and a Mach-O segment name; Linux (and other
// ELF hosts) just postject the blob into a note section — no signing.
function buildBinary(blob) {
  const bin = seaBin(REPO);                          // clode.exe on win32, clode elsewhere
  // Robust copy: fs.copyFileSync uses copy_file_range on Linux, which returns EIO on
  // some filesystems (autofs / network mounts). A plain read+write avoids it.
  fs.writeFileSync(bin, fs.readFileSync(process.execPath)); // embed THIS node
  fs.chmodSync(bin, 0o755);                          // no-op on Windows, harmless
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', bin]);
  if (process.platform === 'win32') {
    // The official node.exe is Authenticode-signed; postject rewrites the PE and
    // invalidates it. Remove it first when signtool is available; tolerate its absence
    // (we ship unsigned regardless — the stale signature is cosmetic for an unsigned dist).
    try { execFileSync('signtool', ['remove', '/s', bin], { stdio: 'inherit' }); }
    catch { console.error('build-sea: signtool unavailable — shipping unsigned'); }
  }
  const args = [bin, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  runBin('postject', args, { stdio: 'inherit' });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', bin]); // ad-hoc; required or it won't run
  return bin;
}

// Fail the build loudly if the produced binary doesn't actually run. The classic
// failure is a STRIPPED embedded node: postject can't inject into a stripped binary
// without corrupting the ELF, and the dynamic loader then segfaults at startup — a
// runtime-only symptom we catch here at build time.
function smokeCheck(bin) {
  // 1. It runs at all. The classic failure is a STRIPPED embedded node: postject can't
  //    inject into it without corrupting the ELF, and the loader segfaults at startup.
  const r = spawnSync(bin, ['--clode-version'], { encoding: 'utf8' });
  if (!(r.status === 0 && /^clode \d+\.\d+\.\d+/.test(r.stdout || ''))) {
    console.error(`SEA self-check FAILED${r.signal ? ` (crashed with ${r.signal})` : ''}: ` +
      `'${bin} --clode-version' did not print the version.`);
    if (r.signal === 'SIGSEGV') {
      console.error('A SIGSEGV at startup almost always means the embedded node was a STRIPPED');
      console.error('binary — postject corrupts stripped nodes and the loader crashes. Build with');
      console.error('an official, non-stripped Node (an asdf/nvm nodejs.org build), not a distro-');
      console.error('stripped /usr/bin/node.');
    }
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }
  // 2. Best-effort DEEP check: if a provider is resolvable, boot the REAL bundle once
  //    (offline `--version`) — this exercises deps/extractor materialization + run-as-
  //    node, catching a corrupt deps.tar or stale embedded extractor that step 1 can't.
  //    Skipped (with a note) when no provider is available at build time.
  const provider = process.env.CLODE_CLAUDE_BIN
    || ['/usr/bin/claude', '/usr/local/bin/claude'].find((p) => fs.existsSync(p));
  if (!provider) {
    console.error('SEA self-check: skipped deep boot (no provider; set CLODE_CLAUDE_BIN to enable)');
    return;
  }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-selfcheck-'));
  try {
    const boot = spawnSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, CLODE_CACHE: cache, CLODE_CLAUDE_BIN: provider },
    });
    if (boot.status !== 0 || /Cannot find module|MODULE_NOT_FOUND/.test(boot.stderr || '')) {
      console.error('SEA self-check FAILED: the binary could not boot the real bundle ' +
        '(corrupt deps asset or stale embedded extractor?).');
      if (boot.stderr) console.error(boot.stderr);
      process.exit(1);
    }
    console.error('SEA self-check: booted the real bundle OK');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

ensureToolchain();
const bundle = esbuildBundle();
console.error(`esbuild → ${bundle}`);
if (process.argv.includes('--bundle-only')) process.exit(0);
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 24) { console.error(`SEA embed node is v${process.versions.node}; need >= v24`); process.exit(1); }
const { tar, sigFile } = stageDeps();
const { cfgPath, blob } = writeSeaConfig(bundle, tar, sigFile);
execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });
const bin = buildBinary(blob);
smokeCheck(bin);
console.error(`SEA → ${bin}`);

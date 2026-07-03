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

// Run npm by launching its OWN JS CLI under THIS node, rather than the `npm`/`npm.cmd`
// launcher. Uniform on every OS, and it sidesteps the Windows-only `npm.cmd`+shell path
// (cmd.exe can't run from a UNC cwd and strips quotes from args). npm ships inside every
// node install; the file sits at a different spot on Windows vs POSIX, so probe both.
function npmCliPath() {
  const d = path.dirname(process.execPath);
  const found = [
    path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'),              // Windows dist layout
    path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX dist layout
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`build-sea: could not locate npm-cli.js next to ${process.execPath}`);
  return found;
}
const NPM_CLI = npmCliPath();
function runNpm(args, opts) { execFileSync(process.execPath, [NPM_CLI, ...args], opts); }

// Load a build-only toolchain package's JS API (esbuild, postject) from the per-tag dir. We
// use the APIs, not the CLIs: esbuild's published bin/esbuild is a NATIVE binary on POSIX but
// a node shim on Windows (so "run the bin under node" isn't portable either way), and the
// APIs take real values — no shell, no quote-stripping, no bin-shape guessing.
const toolRequire = createRequire(path.join(TOOLCHAIN, 'package.json'));

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
  runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: TOOLCHAIN });
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
  // define values are strings that must be valid JSON — JSON.stringify(version) yields the
  // quoted "0.1.0" esbuild expects. Passing it as a real object (not a CLI arg) means no shell
  // and nothing to strip the quotes, unlike a `--define:...="0.1.0"` command line.
  toolRequire('esbuild').buildSync({
    entryPoints: [path.join(REPO, 'libexec', 'clode-main.cjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    define: { __CLODE_BUNDLE_VERSION__: JSON.stringify(repoVersion()) },
    outfile: bundle,
  });
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
    runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: staging });
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

// Delegate the SEA binary's signing to scripts/sea-sign.cjs so THIS build issues one uniform
// command per phase on every OS; the codesign/signtool branching lives inside that CLI.
// phase is 'unsign' (before injection) or 'sign' (after).
function seaSign(phase, bin) {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'sea-sign.cjs'), phase, bin], { stdio: 'inherit' });
}

// Embed THIS node (the running interpreter) + the blob into a stand-alone binary. The steps
// are identical on every OS except the two genuinely per-format bits: the Mach-O segment name
// postject needs on macOS, and the OS signing (isolated in sea-sign.cjs).
async function buildBinary(blob) {
  const bin = seaBin(REPO);                          // clode.exe on win32, clode elsewhere
  // A just-run binary can stay locked briefly (Windows keeps the image section open past
  // process exit, and AV may be scanning the ~90MB file), so overwriting it in place can throw
  // EBUSY — making a rebuild-then-run test flaky. Renaming the stale binary aside is permitted
  // even while it's locked and frees the path for a clean write; the sidecar is removed
  // best-effort — immediately on POSIX, on a later build if Windows still holds it. Same code
  // on every platform (on POSIX it's simply a rename+unlink that always succeeds).
  if (fs.existsSync(bin)) {
    const dir = path.dirname(bin), base = path.basename(bin);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${base}.stale-`)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
    }
    const stale = path.join(dir, `${base}.stale-${process.pid}`);
    try { fs.renameSync(bin, stale); fs.rmSync(stale, { force: true }); } catch {}
  }
  // Robust copy: fs.copyFileSync uses copy_file_range on Linux, which returns EIO on
  // some filesystems (autofs / network mounts). A plain read+write avoids it.
  fs.writeFileSync(bin, fs.readFileSync(process.execPath)); // embed THIS node
  fs.chmodSync(bin, 0o755);                          // no-op on Windows, harmless
  seaSign('unsign', bin);                            // strip any signature so postject can rewrite
  // Inject the blob via postject's JS API (same portability reason as esbuild above).
  await toolRequire('postject').inject(bin, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    // Mach-O stores the blob in a named segment; irrelevant (and omitted) on PE/ELF — the one
    // unavoidable per-format detail, expressed here as an option rather than a code branch.
    machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
  });
  seaSign('sign', bin);                              // re-apply the OS signature (ad-hoc on macOS)
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
const bin = await buildBinary(blob);
smokeCheck(bin);
console.error(`SEA → ${bin}`);

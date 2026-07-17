#!/usr/bin/env node
'use strict';
// Build the naude Node SEA (host platform, embedded = the node running this script).
//
// naude = "Claude Code baked into a Node SEA". Unlike the retired clode SEA (which
// embedded the EXTRACTOR and pulled Claude Code at runtime), naude embeds a BAKED
// `cli.cjs` (the caller's already-built Claude Code, passed in via `--cli`) directly
// as a node:sea asset. It is a LOCAL build target — it carries Anthropic's code baked
// in, so it is NEVER shipped; only the builder (clode) ships. Accordingly this pipeline
// does NOT embed extract-claude-js.cjs.
//
// The SEA's `main` is the esbuilt `libexec/naude-entry.cjs`; its assets are the deps
// tarball (+ sig), the `bun-shim.cjs`, and the `cli.cjs` given by `--cli`. The bun-shim
// is read from the extract STAGE DIR beside that cli.cjs — version-locked to the bundle
// by the cache, the same rule quaude's fuse follows (see stagedBunShim).
//
// Recovered from clode's first-release SEA build (scripts/build-sea.mjs, retired in
// 13eeb86) and repointed at naude. The proven cross-platform machinery (per-tag
// toolchain via pinned `npm ci`, local-disk deps staging, postject inject, OS re-sign,
// smoke check) is kept faithful to the original.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { toolchainDir, artifactDir, seaBin } = require('./platform-tag.cjs');
const { runNpm: runNpmShared } = require('./lib/npm-cli.cjs');

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// Three DIFFERENT keys for three different things — see scripts/platform-tag.cjs's
// file header for the full rationale (a future reader must not re-merge them):
//   * TOOLCHAIN (esbuild+postject node_modules) — a native tool cache, keyed by
//     platform+node-major (toolchainDir). Never shipped.
//   * BUNDLE_DIR (the esbuilt naude-entry.bundle.cjs) — platform-INDEPENDENT pure
//     JS, keyed by NOTHING (one unkeyed location shared with clode-main.bundle.cjs).
//   * OUT (deps.tar/.sig, sea-config.json, sea-prep.blob, and the final naude
//     binary) — the SHIPPABLE artifact + its intermediates, keyed by the artifact
//     name (artifactDir; CLODE_ASSET_NAME overrides it — see its comment). This is
//     what buys "if it's in build/clode-*, it's shippable."
const TOOLCHAIN = toolchainDir(REPO);
const BUNDLE_DIR = path.join(REPO, 'build', 'bundle');
const OUT = artifactDir(REPO);

// npmCliPath/runNpm (the "run npm's OWN JS CLI under THIS node" trick — see
// scripts/lib/npm-cli.cjs for the full rationale) are shared with build-clode-main.mjs,
// which had a byte-identical copy of this logic. Resolved LAZILY (inside runNpm, on
// every call) rather than once up front — preserved from the pre-extraction behavior
// of this file.
function runNpm(args, opts) { runNpmShared(args, opts, { prefix: 'build-naude' }); }

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
  // is deps/clode/package.json (clode's OWN build-time toolchain — esbuild/postject —
  // kept OUT of deps/clode/node_modules because they're native per-platform binaries;
  // see deps/clode/package.json's description for the full asymmetry rationale).
  fs.copyFileSync(path.join(REPO, 'deps', 'clode', 'package.json'), path.join(TOOLCHAIN, 'package.json'));
  // Prefer a reproducible, pinned install: copy the committed lockfile and `npm ci`.
  // Fall back to `npm install` only when no lockfile is present.
  const lock = path.join(REPO, 'deps', 'clode', 'package-lock.json');
  const cmd = fs.existsSync(lock)
    ? (fs.copyFileSync(lock, path.join(TOOLCHAIN, 'package-lock.json')), ['ci'])
    : ['install'];
  console.error(`toolchain: installing esbuild+postject into ${path.relative(REPO, TOOLCHAIN)}`);
  // cwd: TOOLCHAIN (not --prefix) so npm reads this manifest as the root — see stageDeps.
  runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: TOOLCHAIN });
}

// esbuild the naude SEA `main` — libexec/naude-entry.cjs (the SEA entry that materializes
// the embedded assets and runs the baked cli.cjs), NOT clode-main. naude carries no
// build-time VERSION define: naude-entry has no version constant to inject; the baked
// cli.cjs reports its own version. It DOES carry a BUILDER define (below) — the clode
// that is building this naude, so its patched in-app updater can call back here
// (CLODE_SELF) because a baked SEA cannot rebuild itself. define values are strings
// that must be valid JS source — JSON.stringify(path) yields the quoted string literal
// esbuild expects (see build-clode-main.mjs's __CLODE_BUNDLE_VERSION__ for the same pattern).
function esbuildBundle() {
  const bundle = path.join(BUNDLE_DIR, 'naude-entry.bundle.cjs');
  toolRequire('esbuild').buildSync({
    entryPoints: [path.join(REPO, 'libexec', 'naude-entry.cjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    // Only clode knows the builder path (it passes CLODE_SELF). argv[1] here is
    // build-naude.mjs's OWN path — baking that would point the updater at a
    // non-CLI. Unknown must stay null so CLODE_SELF is left unset and the
    // patched updater fails loud.
    define: { __CLODE_BUILDER__: JSON.stringify(process.env.CLODE_SELF || null) },
    outfile: bundle,
  });
  return bundle;
}

// Stage the shipped runtime deps (deps/claude/package.json — Claude Code's
// deps, baked into the built target; NOT clode's own, clode has none) and tar
// the resulting node_modules as the embedded deps asset. A sha256 of the tar
// is the sig materializeDeps keys the extraction cache on.
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
  const lock = path.join(REPO, 'deps', 'claude', 'package-lock.json');
  const manifest = fs.existsSync(lock) ? lock : path.join(REPO, 'deps', 'claude', 'package.json');
  const lockHash = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
  if (fs.existsSync(tar) && fs.existsSync(sigFile) && fs.existsSync(lockHashFile)
      && fs.readFileSync(lockHashFile, 'utf8') === lockHash) {
    console.error('deps: reusing cached deps.tar (lockfile unchanged)');
    return { tar, sigFile };
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-deps-'));
  try {
    fs.copyFileSync(path.join(REPO, 'deps', 'claude', 'package.json'), path.join(staging, 'package.json'));
    // Prefer a reproducible install: copy the committed lockfile and `npm ci` (exact,
    // locked versions). Fall back to `npm install` only if no lockfile is present.
    const cmd = fs.existsSync(lock)
      ? (fs.copyFileSync(lock, path.join(staging, 'package-lock.json')), ['ci', '--omit=dev'])
      : ['install', '--omit=dev'];
    // Run npm IN the staging dir (cwd), not via --prefix: with --prefix, npm mis-derives
    // the root package name from the prefix's basename when cwd is a different package,
    // and `npm ci` then fails the lockfile sync check.
    runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: staging });
    // Archive to STDOUT (`-f -`) with the staging dir as the process cwd, instead of passing
    // OS-native paths as tar arguments. On Windows under a bash PATH `tar` resolves to GNU tar,
    // which reads an archive path like `D:\…\deps.tar` as a remote `host:path` (the drive-letter
    // colon) and dies "Cannot connect to D: resolve failed". With no colon-bearing path args —
    // `-f -` for stdout and cwd set by the OS, not parsed by tar — this is uniform on GNU tar
    // (Windows/Linux) and bsdtar (macOS). The result is an identically-STRUCTURED standard tar
    // (same member layout as the old `-cf <file> -C staging`); tar output isn't bit-reproducible
    // in general, but the deps.sig sha256 is recomputed from whatever archive we produce.
    const archive = execFileSync('tar', ['-cf', '-', 'node_modules'], { cwd: staging, maxBuffer: 1 << 30 });
    fs.writeFileSync(tar, archive);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const sig = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
  fs.writeFileSync(sigFile, sig);
  fs.writeFileSync(lockHashFile, lockHash);
  return { tar, sigFile };
}

// PURE sea-config generator: the node:sea config object naude's SEA embeds. main = the
// esbuilt naude-entry bundle; assets = the deps tarball (+ sig), the bun-shim (staged
// beside the cli.cjs — see stagedBunShim), and the BAKED cli.cjs (the caller's Claude
// Code, given via `--cli`). Crucially there is NO
// `extract-claude-js.cjs` asset — naude bakes CC, it never extracts at runtime. Exported
// and side-effect-free so it's unit-testable without building a real SEA.
export function naudeSeaConfig({ mainBundle, cliCjs, bunShim, tar, sig, out }) {
  return {
    main: mainBundle,
    output: path.join(out, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,   // don't print node's SEA warning on every run
    assets: {
      'deps.tar': tar,
      'deps.sig': sig,
      'bun-shim.cjs': bunShim,
      'cli.cjs': cliCjs,
    },
  };
}

// The bun-shim to bake, from the SAME staged location quaude reads (duplication
// audit §5). `--cli` names the extracted stage dir's cli.cjs; the shim is its
// sibling there, put there by the extract stage — so both build targets are
// version-locked to the bundle they were extracted with, exactly as
// quaude-fuse.js's "version-locked to the bundle by the cache" comment says.
// This used to read REPO/libexec/bun-shim.cjs, ignoring the stage dir the
// --naude branch had just populated. The bytes agreed only BY ACCIDENT:
// clode-extract.cjs re-copies libexec/bun-shim.cjs over the cached one on every
// cache hit. If the shim is ever pinned per bundle version — which is the stated
// intent — naude would silently bake a DIFFERENT shim than quaude from the same
// inputs, and the parity oracle would not catch it.
export function stagedBunShim(cliCjs) {
  return path.join(path.dirname(cliCjs), 'bun-shim.cjs');
}

function writeSeaConfig({ bundle, cliCjs, tar, sigFile }) {
  const bunShim = stagedBunShim(cliCjs);
  if (!fs.existsSync(bunShim)) {
    // Fail loud rather than silently baking no shim (or reaching back to the
    // repo for one): the shim MUST come from the same stage as the cli.cjs.
    console.error(`build-naude: no bun-shim.cjs beside the staged --cli: ${bunShim}`);
    console.error('The bun-shim is version-locked to the bundle by the extract cache; pass a --cli from a');
    console.error("staged cache dir (what `clode build --naude` does), not a bare cli.cjs.");
    process.exit(1);
  }
  const cfg = naudeSeaConfig({
    mainBundle: bundle,
    cliCjs,
    bunShim,
    tar,
    sig: sigFile,
    out: OUT,
  });
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
//
// outOverride (from --out) picks WHERE the final binary lands; OUT (deps.tar, blob,
// sea-config) is unaffected either way, same convention as clode-fuse.cjs's quaude
// --out (an explicit path is the user's, verbatim; only the default gets the
// artifact-name treatment, here build/<artifact-name>/naude instead of a bare basename).
async function buildBinary(blob, outOverride) {
  const bin = outOverride || seaBin(REPO, 'naude');  // naude.exe on win32, naude elsewhere
  fs.mkdirSync(path.dirname(bin), { recursive: true });
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
//
// naude bakes CC, so the self-check boots the REAL baked bundle: an offline `--version`
// materializes the deps + assets, re-invokes as node, and runs the baked cli.cjs, which
// prints Claude Code's version and exits 0. A stripped-node SIGSEGV or a corrupt deps
// asset both surface here.
function smokeCheck(bin) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-selfcheck-'));
  try {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, NAUDE_CACHE: cache },
    });
    if (r.status !== 0 || /Cannot find module|MODULE_NOT_FOUND/.test(r.stderr || '')) {
      console.error(`naude self-check FAILED${r.signal ? ` (crashed with ${r.signal})` : ''}: ` +
        `'${bin} --version' did not boot the baked bundle.`);
      if (r.signal === 'SIGSEGV') {
        console.error('A SIGSEGV at startup almost always means the embedded node was a STRIPPED');
        console.error('binary — postject corrupts stripped nodes and the loader crashes. Build with');
        console.error('an official, non-stripped Node (an asdf/nvm nodejs.org build), not a distro-');
        console.error('stripped /usr/bin/node.');
      }
      if (r.stderr) console.error(r.stderr);
      process.exit(1);
    }
    console.error('naude self-check: booted the baked bundle OK');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

// Parse `--cli <path>`: the baked Claude Code cli.cjs to embed. REQUIRED.
function parseCliArg(argv) {
  const i = argv.indexOf('--cli');
  const cli = i >= 0 ? argv[i + 1] : undefined;
  if (!cli) {
    console.error('build-naude: missing required --cli <path-to-cli.cjs> (the baked Claude Code).');
    console.error('naude bakes CC in; pass the already-built cli.cjs to embed as the cli.cjs asset.');
    process.exit(1);
  }
  const resolved = path.resolve(cli);
  if (!fs.existsSync(resolved)) {
    console.error(`build-naude: --cli path does not exist: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}

// Parse `--out <path>`: where the final naude binary is written. OPTIONAL —
// defaults to seaBin(REPO, 'naude') (build/<artifact-name>/naude[.exe]) when
// absent, same as every other --out consumer in this repo. Resolved to an absolute path here
// (once) so every downstream consumer (buildBinary, the log line) gets the same
// value regardless of the caller's cwd.
export function parseOutArg(argv) {
  const i = argv.indexOf('--out');
  if (i < 0) return null;
  const p = argv[i + 1];
  if (!p) {
    console.error('build-naude: --out requires a path argument.');
    process.exit(1);
  }
  return path.resolve(p);
}

async function main() {
  const argv = process.argv.slice(2);
  const cliCjs = parseCliArg(argv);
  const outOverride = parseOutArg(argv);
  fs.mkdirSync(TOOLCHAIN, { recursive: true });
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  ensureToolchain();
  const bundle = esbuildBundle();
  console.error(`esbuild → ${bundle}`);
  if (argv.includes('--bundle-only')) return;
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 24) { console.error(`SEA embed node is v${process.versions.node}; need >= v24`); process.exit(1); }
  const { tar, sigFile } = stageDeps();
  const { cfgPath, blob } = writeSeaConfig({ bundle, cliCjs, tar, sigFile });
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });
  const bin = await buildBinary(blob, outOverride);
  smokeCheck(bin);
  console.error(`naude SEA → ${bin}`);
}

// Run the pipeline ONLY when invoked as the entry script. Importing this module (e.g. the
// pure-config unit test) must run nothing — esbuild/postject aren't available everywhere.
if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main();
}

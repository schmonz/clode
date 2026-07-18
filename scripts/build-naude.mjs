#!/usr/bin/env node
'use strict';
// Build the naude Node SEA. Unlike the retired clode SEA (which embedded the
// EXTRACTOR and pulled Claude Code at runtime), naude embeds a BAKED `cli.cjs`
// (the caller's already-built Claude Code, passed in via `--cli`) directly as
// a node:sea asset. It is a LOCAL build target — it carries Anthropic's code
// baked in, so it is NEVER shipped; only the builder (clode) ships.
//
// Task 5 (clode-fetches-naude-engine): this script no longer runs esbuild or
// npm on the user's machine. Everything it used to produce or fetch for
// itself is now a GIVEN, injectable input:
//   --node     the node to embed AND to run --experimental-sea-config with
//              (was always process.execPath; now parameterized so a fetched
//              node — Task 6 — or any other node can be used, and so the
//              embed/blob-gen steps are unit-testable without a real build).
//   --bundle   the pre-esbuilt SEA `main` (libexec/naude-entry.cjs, esbuilt by
//              scripts/build-clode-main.mjs — Task 4). This script never
//              esbuilds it.
//   --nmdir    a resolved node_modules to tar as the deps asset. This script
//              never `npm ci`s it — the caller (a checkout's deps/claude, or
//              a fused builder's materialized payload) already has it on disk.
//   --builder  the clode building this naude (its patched updater's callback
//              target). Used to be burned into the bundle via an esbuild
//              --define; now it rides as a `builder` SEA asset (naudeSeaConfig,
//              Task 3) — the deferred wiring THIS task lands: writeSeaConfig
//              actually threads it through (previously it did not, so every
//              naude built through this path baked NO builder at all).
//   --postject the directory carrying postject's JS API (dist/api.js) this
//              script calls to inject the SEA blob.
// All five default to the checkout's own locations/running node, so a plain
// `node scripts/build-naude.mjs --cli <staged cli.cjs>` still builds a working
// naude on a host that has them (unchanged end-user experience for a dev
// checkout); the flags exist for a caller that has already resolved/fetched
// these from somewhere else.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { artifactDir, seaBin } = require('./platform-tag.cjs');

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// Two DIFFERENT keys for two different things — see scripts/platform-tag.cjs's
// file header for the full rationale (a future reader must not re-merge them):
//   * BUNDLE_DIR (the esbuilt naude-entry.bundle.cjs, --bundle's default) —
//     platform-INDEPENDENT pure JS, keyed by NOTHING (one unkeyed location
//     shared with clode-main.bundle.cjs). This script no longer produces it
//     (scripts/build-clode-main.mjs does — Task 4); it only reads it.
//   * OUT (deps.tar/.sig, sea-config.json, sea-prep.blob, and the final naude
//     binary) — the SHIPPABLE artifact + its intermediates, keyed by the
//     artifact name (artifactDir; CLODE_ASSET_NAME overrides it — see its
//     comment). This is what buys "if it's in build/clode-*, it's shippable."
// The old TOOLCHAIN dir (esbuild+postject node_modules, native-tool-cache,
// keyed by platform+node-major) is GONE from this file: Task 5 deletes both
// the esbuild half (the bundle is now always pre-built and given via
// --bundle) and the postject half (postject is now given via --postject,
// never npm-installed by this script).
const BUNDLE_DIR = path.join(REPO, 'build', 'bundle');
const OUT = artifactDir(REPO);

// require() an absolute directory path directly (not by bare-specifier
// resolution): postject's own package.json ("main": "dist/api.js") makes this
// work regardless of whether the directory sits under any node_modules
// ancestor at all — the caller can hand this script literally any directory
// that looks like postject (deps/clode/node_modules/postject in a checkout, a
// fused builder's materialized payload, a CI-provisioned toolchain dir, ...).
const requireAbs = createRequire(path.join(REPO, 'package.json'));

// --node <path>: the node binary to embed (buildBinary) and to run
// `--experimental-sea-config` with (generateBlob), and whose version the
// >=24 guard checks. OPTIONAL — defaults to process.execPath, so an
// unparameterized run keeps embedding the node actually running this script,
// exactly as before this task.
export function parseNodeArg(argv) {
  const i = argv.indexOf('--node');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : process.execPath;
}

// --bundle <path>: the pre-esbuilt SEA `main`. OPTIONAL — defaults to the
// checkout's unkeyed bundle location (BUNDLE_DIR), matching where
// scripts/build-clode-main.mjs writes it.
export function parseBundleArg(argv) {
  const i = argv.indexOf('--bundle');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(BUNDLE_DIR, 'naude-entry.bundle.cjs');
}

// --nmdir <path>: the resolved node_modules to tar as the deps asset.
// OPTIONAL — defaults to deps/claude/node_modules (Claude Code's own runtime
// deps in this checkout; NOT clode's own — clode has none).
export function parseNmdirArg(argv) {
  const i = argv.indexOf('--nmdir');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(REPO, 'deps', 'claude', 'node_modules');
}

// --builder <path>: the clode building this naude — see naudeSeaConfig's
// comment for the full rationale. OPTIONAL. Precedence: an explicit --builder
// wins; else CLODE_SELF from `env` (the historical source, preserved as a
// fallback so nothing that already sets it breaks); else null. A null builder
// is not an error here — it is the fail-loud-not-wrong invariant: no builder
// known now means no `builder` asset later, and the baked updater refuses to
// call back to a non-existent path rather than guessing one.
export function parseBuilderArg(argv, env = process.env) {
  const i = argv.indexOf('--builder');
  if (i >= 0) return argv[i + 1] || null;
  return env.CLODE_SELF || null;
}

// --postject <dir>: postject's own package directory (contains its
// package.json + dist/api.js + dist/cli.js). OPTIONAL — defaults to
// deps/clode/node_modules/postject, the location `npm ci --prefix deps/clode`
// populates in a checkout (mirrors --nmdir's default).
export function parsePostjectArg(argv) {
  const i = argv.indexOf('--postject');
  return i >= 0 && argv[i + 1]
    ? path.resolve(argv[i + 1])
    : path.join(REPO, 'deps', 'clode', 'node_modules', 'postject');
}

// Stage the shipped runtime deps (the GIVEN --nmdir, e.g.
// deps/claude/node_modules — Claude Code's deps, baked into the built target;
// NOT clode's own, clode has none) and tar it as the embedded deps asset. A
// sha256 of the tar is the sig materializeDeps keys the extraction cache on.
//
// Task 5: this used to `npm ci` a fresh staging copy itself; it now only
// archives what the caller already resolved. Cached on a key derived from
// nmdir's sibling lockfile (deps/claude/package-lock.json in the checkout
// default) when one exists, else nmdir's own mtime — skips the tar entirely
// when the key is unchanged, which also keeps deps.sig STABLE across rebuilds
// (a fresh tar's mtimes would churn the sig and needlessly bust every
// client's runtime extraction cache).
export function stageDeps(nmdir) {
  if (!fs.existsSync(nmdir)) {
    console.error(`build-naude: --nmdir does not exist: ${nmdir}`);
    console.error('naude bakes a deps tarball from a REAL node_modules; pass --nmdir <dir>');
    console.error("or populate the checkout default (deps/claude/node_modules, e.g. via");
    console.error("'npm ci --prefix deps/claude').");
    process.exit(1);
  }
  const tar = path.join(OUT, 'deps.tar');
  const sigFile = path.join(OUT, 'deps.sig');
  const keyFile = path.join(OUT, 'deps.key');
  const parent = path.dirname(nmdir);
  const lock = path.join(parent, 'package-lock.json');
  const key = fs.existsSync(lock)
    ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')}`
    : `mtime:${fs.statSync(nmdir).mtimeMs}`;
  if (fs.existsSync(tar) && fs.existsSync(sigFile) && fs.existsSync(keyFile)
      && fs.readFileSync(keyFile, 'utf8') === key) {
    console.error('deps: reusing cached deps.tar (nmdir unchanged)');
    return { tar, sigFile };
  }
  // Archive to STDOUT (`-f -`) with nmdir's PARENT as cwd, instead of passing
  // OS-native paths as tar arguments. On Windows under a bash PATH `tar`
  // resolves to GNU tar, which reads an archive path like `D:\…\deps.tar` as a
  // remote `host:path` (the drive-letter colon) and dies "Cannot connect to
  // D: resolve failed". With no colon-bearing path args — `-f -` for stdout
  // and cwd set by the OS, not parsed by tar — this is uniform on GNU tar
  // (Windows/Linux) and bsdtar (macOS).
  const archive = execFileSync('tar', ['-cf', '-', 'node_modules'], { cwd: parent, maxBuffer: 1 << 30 });
  fs.writeFileSync(tar, archive);
  const sig = crypto.createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(sigFile, sig);
  fs.writeFileSync(keyFile, key);
  return { tar, sigFile };
}

// PURE sea-config generator: the node:sea config object naude's SEA embeds. main = the
// esbuilt naude-entry bundle; assets = the deps tarball (+ sig), the bun-shim (staged
// beside the cli.cjs — see stagedBunShim), and the BAKED cli.cjs (the caller's Claude
// Code, given via `--cli`). Crucially there is NO
// `extract-claude-js.cjs` asset — naude bakes CC, it never extracts at runtime. Exported
// and side-effect-free so it's unit-testable without building a real SEA.
// `builder` is the absolute path of the clode building this naude (a naude cannot
// rebuild itself, so its patched in-app updater calls back to the builder — see
// naude-entry.cjs's bakedBuilder). It used to be burned into the bundle via an
// esbuild --define; now it's runtime data, a `builder` asset, so the SAME esbuilt
// naude-entry bundle serves every build regardless of who built it. A non-empty
// string is written to <out>/builder.txt and added as the asset; null/empty omits
// the asset entirely, preserving the "no builder -> updater fails loud" contract
// naude-entry.cjs's bakedBuilder implements on the read side.
export function naudeSeaConfig({ mainBundle, cliCjs, bunShim, tar, sig, out, builder }) {
  const assets = {
    'deps.tar': tar,
    'deps.sig': sig,
    'bun-shim.cjs': bunShim,
    'cli.cjs': cliCjs,
  };
  if (builder) {
    const builderFile = path.join(out, 'builder.txt');
    fs.writeFileSync(builderFile, builder);
    assets.builder = builderFile;
  }
  return {
    main: mainBundle,
    output: path.join(out, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,   // don't print node's SEA warning on every run
    assets,
  };
}

// The bun-shim to bake, from the SAME staged location quaude reads (duplication
// audit §5). `--cli` names the extracted stage dir's cli.cjs; the shim is its
// sibling there, put there by the extract stage — so both build targets are
// version-locked to the bundle they were extracted with, exactly as
// quaude-fuse.js's "version-locked to the bundle by the cache" comment says.
export function stagedBunShim(cliCjs) {
  return path.join(path.dirname(cliCjs), 'bun-shim.cjs');
}

// Writes sea-config.json from naudeSeaConfig, resolving the bun-shim from the
// staged location beside --cli. `builder` (Task 5's deferred wiring, landed
// here): threaded straight through to naudeSeaConfig — previously this
// function silently omitted it, so every naude built via this path baked NO
// builder asset at all, regardless of CLODE_SELF/--builder, and its patched
// updater always failed loud with no callback target. Exported so a test can
// assert the threading without a full build.
export function writeSeaConfig({ bundle, cliCjs, tar, sigFile, builder }) {
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
    builder,
  });
  const p = path.join(OUT, 'sea-config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return { cfgPath: p, blob: cfg.output };
}

// Delegate the SEA binary's signing to scripts/sea-sign.cjs so THIS build issues one uniform
// command per phase on every OS; the codesign/signtool branching lives inside that CLI.
// phase is 'unsign' (before injection) or 'sign' (after). This is a build-time helper step
// (codesign/signtool), not part of the embedded target, so it always runs under the AUTHORING
// node (process.execPath — the node running this script), independent of --node.
function seaSign(phase, bin) {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'sea-sign.cjs'), phase, bin], { stdio: 'inherit' });
}

// Run the GIVEN node with `--experimental-sea-config` to materialize the SEA
// blob. Used to always be process.execPath; nodePath is now a real parameter
// (Task 5) so a fetched/given node drives it. `execFileSync` is an injectable
// seam (matching scripts/lib/npm-cli.cjs's pattern) so a unit test can assert
// WHICH node was invoked without a real Node >= 24 SEA-config pass.
export function generateBlob(nodePath, cfgPath, { execFileSync: exec = execFileSync } = {}) {
  exec(nodePath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });
}

// Embed the GIVEN node (nodePath) + the blob into a stand-alone binary. The steps
// are identical on every OS except the two genuinely per-format bits: the Mach-O segment name
// postject needs on macOS, and the OS signing (isolated in sea-sign.cjs).
//
// outOverride (from --out) picks WHERE the final binary lands; OUT (deps.tar, blob,
// sea-config) is unaffected either way, same convention as clode-fuse.cjs's quaude
// --out (an explicit path is the user's, verbatim; only the default gets the
// artifact-name treatment, here build/<artifact-name>/naude instead of a bare basename).
//
// nodePath/postjectDir are real parameters (Task 5: this used to embed
// process.execPath and require('postject') from a self-installed toolchain
// dir). readNode/requirePostject/sign are injectable seams (default to the
// real fs read / requireAbs / seaSign) so a unit test can assert "the GIVEN
// node's bytes were embedded, not process.execPath's" without a real postject
// inject or OS codesign pass.
export async function buildBinary({
  nodePath, postjectDir, blob, outOverride,
  readNode = (p) => fs.readFileSync(p),
  requirePostject: reqPostject = (dir) => requireAbs(dir),
  sign = seaSign,
}) {
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
  fs.writeFileSync(bin, readNode(nodePath)); // embed the GIVEN node
  fs.chmodSync(bin, 0o755);                          // no-op on Windows, harmless
  sign('unsign', bin);                                // strip any signature so postject can rewrite
  // Inject the blob via postject's JS API (same portability reason as esbuild used to be).
  await reqPostject(postjectDir).inject(bin, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    // Mach-O stores the blob in a named segment; irrelevant (and omitted) on PE/ELF — the one
    // unavoidable per-format detail, expressed here as an option rather than a code branch.
    machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
  });
  sign('sign', bin);                                  // re-apply the OS signature (ad-hoc on macOS)
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
  const nodePath = parseNodeArg(argv);
  const bundle = parseBundleArg(argv);
  const nmdir = parseNmdirArg(argv);
  const builder = parseBuilderArg(argv);
  const postjectDir = parsePostjectArg(argv);
  fs.mkdirSync(OUT, { recursive: true });

  if (!fs.existsSync(bundle)) {
    console.error(`build-naude: --bundle not found: ${bundle}`);
    console.error("Pre-build it with 'node scripts/build-clode-main.mjs' (esbuilds naude-entry.bundle.cjs");
    console.error('alongside clode-main.bundle.cjs) — this script no longer esbuilds it itself.');
    process.exit(1);
  }

  const nodeVersion = execFileSync(nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
  const major = parseInt(nodeVersion.split('.')[0], 10);
  if (major < 24) {
    console.error(`SEA embed node (${nodePath}) is v${nodeVersion}; need >= v24`);
    process.exit(1);
  }

  const { tar, sigFile } = stageDeps(nmdir);
  const { cfgPath, blob } = writeSeaConfig({ bundle, cliCjs, tar, sigFile, builder });
  generateBlob(nodePath, cfgPath);
  const bin = await buildBinary({ nodePath, postjectDir, blob, outOverride });
  smokeCheck(bin);
  console.error(`naude SEA → ${bin}`);
}

// Run the pipeline ONLY when invoked as the entry script. Importing this module (e.g. the
// pure-config unit test) must run nothing — postject/a real node embed aren't available
// or wanted everywhere.
if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main();
}

#!/usr/bin/env node
'use strict';
// Build the esbuilt clode-main bundle (build/bundle/clode-main.bundle.cjs) that
// `clode bootstrap` embeds into a quaude in place of the upstream Claude Code
// payload (libexec/clode-build.cjs). This is NOT the SEA builder — the Node
// Single Executable Application pipeline (deps asset, sea-config, blob, postject,
// re-sign, embed) was retired in Phase 4 ("retire the Node SEA builder"). This
// script keeps only the esbuild half that scripts/build-sea.mjs used to do first.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const { toolchainDir } = require('./platform-tag.cjs');
const { npmCliPath, envWithRealNodeOnPath } = require('./lib/npm-cli.cjs');

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// The native tool cache (esbuild) — keyed by platform+node-major (toolchainDir;
// see scripts/platform-tag.cjs's file header for why this key, and why it must
// NOT be the artifact-name key). A shared/NFS `build/` tree can then host
// mutually-incompatible toolchain installs (different OS/OS-version/arch/node)
// without collision.
const TOOLCHAIN = toolchainDir(REPO);
// The bundle itself is platform-INDEPENDENT pure JS (no native code, no
// platform-specific define beyond the repo VERSION) — it is keyed by NOTHING,
// so it gets its own unkeyed home, distinct from the (platform-keyed) toolchain
// that built it and from any (artifact-named) shippable output.
const OUT = path.join(REPO, 'build', 'bundle');
fs.mkdirSync(TOOLCHAIN, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// npmCliPath/runNpm (the "run npm's OWN JS CLI under THIS node" trick — see
// scripts/lib/npm-cli.cjs for the full rationale) are shared with build-naude.mjs,
// which had a byte-identical copy of this logic. NPM_CLI is resolved eagerly here
// (not lazily inside runNpm) so a missing npm fails loud immediately, before any
// other work — preserved from the pre-extraction behavior of this file.
const NPM_CLI = npmCliPath({ prefix: 'build-clode-main' });
// TOOLCHAIN now resolves off-tree (buildPath(), above) — a version-manager shim
// (asdf/mise/volta) resolving `node` by walking up from cwd finds nothing there and
// exits 126 partway through npm's own lifecycle scripts (esbuild's postinstall).
// envWithRealNodeOnPath sidesteps every manager's shim by putting the ALREADY-RUNNING
// real node's dir first on PATH — see scripts/lib/npm-cli.cjs for the full rationale
// and the proof this reproduces on this box.
function runNpm(args, opts) {
  execFileSync(process.execPath, [NPM_CLI, ...args], { ...opts, env: envWithRealNodeOnPath(opts && opts.env) });
}

// Load a build-only toolchain package's JS API (esbuild) from the per-tag dir. We use
// the API, not the CLI: esbuild's published bin/esbuild is a NATIVE binary on POSIX but
// a node shim on Windows (so "run the bin under node" isn't portable either way), and the
// API takes real values — no shell, no quote-stripping, no bin-shape guessing.
const toolRequire = createRequire(path.join(TOOLCHAIN, 'package.json'));

// Provision the build-only toolchain (esbuild) INTO the per-tag dir, so each host
// installs its own native binaries side by side instead of overwriting a shared
// build/node_modules.
//
// IDEMPOTENT ON THE PROPERTY THIS SCRIPT USES, which is the whole of the fix here.
// esbuildBundle() below reaches the toolchain through `toolRequire('esbuild')` and
// esbuild's JS API then spawns its own native child; those two facts together are
// what has to be true. This check used to be `existsSync(node_modules/.bin/esbuild)`
// — a DIFFERENT property, satisfiable without either half — so a cache that met it
// and nothing else was declared provisioned and died forty lines later in the module
// loader, with a `Cannot find module 'esbuild'` that named neither the toolchain nor
// the install that never re-ran.
//
// It is not a hypothetical. toolchainDir() resolves under $TMPDIR (see
// scripts/build-scratch.cjs's candidate order) and macOS reaps /var/folders/*/T on
// its own schedule: com.apple.bsd.dirhelper, StartCalendarInterval 03:35 daily,
// CLEAN_FILES_OLDER_THAN_DAYS=3, deleting FILES by atime and leaving the DIRECTORIES
// standing. On this box on 2026-09-21 at 03:39:31 it took esbuild's package.json and
// lib/main.js (atime 09-17) and spared node_modules/.bin/esbuild, a symlink to the
// one file it left behind — the 10.5MB native binary a build had exec'd at 03:37.
// Nothing in this repo did it and nothing in this repo can stop it; a cache that
// lives somewhere the OS may empty has to VERIFY itself rather than assume.
//
// The probe is a real round trip rather than a bare require, because the native
// child is resolved LAZILY on first use: loading the wrapper proves only half of
// what buildSync needs. Measured ~30ms, once per build.
function ensureToolchain() {
  const loadable = () => {
    try { toolRequire('esbuild').transformSync(''); return true; }
    catch { return false; }
  };
  if (loadable()) return;
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
  console.error(`toolchain: installing esbuild into ${TOOLCHAIN}`);
  runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: TOOLCHAIN });
  // An install that exited 0 and still left nothing loadable is a real failure, and
  // it must be named HERE — by the code that knows which directory it was trying to
  // fill and why — rather than by the loader forty lines on.
  if (!loadable()) {
    throw new Error(`toolchain: esbuild does not load from ${TOOLCHAIN} even after \`npm ${cmd[0]}\` `
      + 'reported success there.\n'
      + '  This dir is a CACHE in scratch space (scripts/build-scratch.cjs), so the likely causes are\n'
      + '  a partially-emptied tree (macOS reaps $TMPDIR files by atime) or an install that could not\n'
      + '  fetch esbuild\'s platform binary.\n'
      + `  FIX: remove ${TOOLCHAIN} and re-run this script, which will install it from scratch.`);
  }
}

// clode's version lives in the VERSION file at the repo root. The esbuilt bundle's
// __dirname is build/<tag> (not the package root), so the runtime file-read in
// clode-main can't find it — inject it at build time as a define. clode-main prefers
// the VERSION file when present (npm/source layout) and falls back to this constant
// (bundle/quaude), so both paths report the real version.
function repoVersion() {
  try { return fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '') || 'dev'; }
  catch { return 'dev'; }
}

// The tjs pin (<ver>-<sha7>, no leading v) this clode targets, from PINS.md — baked
// in so a blobulated clode with no PINS.md can derive its own templates-pack release URL
// for `build --target` auto-fetch (libexec/clode-build.cjs thisTjsPin). MUST match
// tjsPinFromPins + thisTjsPin exactly. Empty string if PINS.md is unreadable; the
// runtime then falls back to CLODE_TJS_PIN/PINS.md.
function bakedTjsPin() {
  try {
    const pins = fs.readFileSync(path.join(REPO, 'spike/quickjs/PINS.md'), 'utf8');
    const m = pins.match(/txiki\.js\s+v?([0-9.]+)\s+([0-9a-f]{7,})/i);
    return m ? `${m[1]}-${m[2].slice(0, 7)}` : '';
  } catch { return ''; }
}

// The ENGINE RECIPE this clode was built from — the same hash
// scripts/engine-recipe.cjs computes and 4f86738 stamps into the published
// templates manifest. Baking it here is the other half: it lets a blobulated clode
// compare what it IS against what a template pack was BUILT FROM, at fetch time,
// which is the only moment the answer matters to a user. Empty in a tree where
// the recipe cannot be computed — the check then declines rather than guessing.
function bakedEngineRecipe() {
  try {
    return execFileSync(process.execPath, [path.join(REPO, 'scripts/engine-recipe.cjs')],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function esbuildBundle() {
  const bundle = path.join(OUT, 'clode-main.bundle.cjs');
  // define values are strings that must be valid JSON — JSON.stringify(version) yields the
  // quoted "0.1.0" esbuild expects. Passing it as a real object (not a CLI arg) means no shell
  // and nothing to strip the quotes, unlike a `--define:...="0.1.0"` command line.
  toolRequire('esbuild').buildSync({
    entryPoints: [path.join(REPO, 'libexec', 'clode-main.cjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    define: {
      __CLODE_BUNDLE_VERSION__: JSON.stringify(repoVersion()),
      __CLODE_BAKED_TJS_PIN__: JSON.stringify(bakedTjsPin()),
      __CLODE_BAKED_ENGINE_RECIPE__: JSON.stringify(bakedEngineRecipe()),
    },
    outfile: bundle,
  });
  return bundle;
}

// The naude entry point, esbuilt off the user path (Task 4). Unlike
// clode-main.bundle.cjs, it carries NO define: Task 3 already turned the
// builder path into a SEA asset rather than an esbuild-time constant, and
// naude-entry has no version/builder constant of its own — so this bundle is
// our-source-only and safe to carry as a builder-role member (see
// libexec/quaude-blobulate.js's builder-role member loop).
function esbuildNaudeEntry() {
  const bundle = path.join(OUT, 'naude-entry.bundle.cjs');
  toolRequire('esbuild').buildSync({
    entryPoints: [path.join(REPO, 'libexec', 'naude-entry.cjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    outfile: bundle,
  });
  return bundle;
}

ensureToolchain();
const bundle = esbuildBundle();
console.error(`esbuild → ${bundle}`);
const naudeEntryBundle = esbuildNaudeEntry();
console.error(`esbuild → ${naudeEntryBundle}`);

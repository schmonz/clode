#!/usr/bin/env node
'use strict';
// Build the esbuilt clode-main bundle (build/bundle/clode-main.bundle.cjs) that
// `clode build --self` embeds into a quaude in place of the upstream Claude Code
// payload (libexec/clode-fuse.cjs). This is NOT the SEA builder — the Node
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
const { npmCliPath } = require('./lib/npm-cli.cjs');

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
function runNpm(args, opts) { execFileSync(process.execPath, [NPM_CLI, ...args], opts); }

// Load a build-only toolchain package's JS API (esbuild) from the per-tag dir. We use
// the API, not the CLI: esbuild's published bin/esbuild is a NATIVE binary on POSIX but
// a node shim on Windows (so "run the bin under node" isn't portable either way), and the
// API takes real values — no shell, no quote-stripping, no bin-shape guessing.
const toolRequire = createRequire(path.join(TOOLCHAIN, 'package.json'));

// Provision the build-only toolchain (esbuild) INTO the per-tag dir, so each host
// installs its own native binaries side by side instead of overwriting a shared
// build/node_modules. Idempotent: skips the install once the .bin shim is present.
function ensureToolchain() {
  const bin = (name) => path.join(TOOLCHAIN, 'node_modules', '.bin', name);
  if (fs.existsSync(bin('esbuild'))) return;
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
  console.error(`toolchain: installing esbuild into ${path.relative(REPO, TOOLCHAIN)}`);
  runNpm([cmd[0], '--no-audit', '--no-fund', ...cmd.slice(1)], { stdio: 'inherit', cwd: TOOLCHAIN });
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

ensureToolchain();
const bundle = esbuildBundle();
console.error(`esbuild → ${bundle}`);

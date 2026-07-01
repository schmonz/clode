#!/usr/bin/env node
'use strict';
// Build the clode Node SEA (host platform, embedded = the node running this script).
// `--bundle-only` stops after esbuild (Task 1); the full pipeline (deps asset,
// sea-config, blob, postject, and macOS re-sign) is appended in Task 5.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

// Stage the shipped runtime deps (root package.json) into a SEPARATE prefix — never
// the repo root — and tar the resulting node_modules as the embedded deps asset. A
// sha256 of the tar is the sig materializeDeps keys the extraction cache on.
function stageDeps() {
  const staging = path.join(OUT, 'deps-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(staging, 'package.json'));
  execFileSync('npm', ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev'], { stdio: 'inherit' });
  const tar = path.join(OUT, 'deps.tar');
  execFileSync('tar', ['-cf', tar, '-C', staging, 'node_modules']);
  const sig = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
  const sigFile = path.join(OUT, 'deps.sig');
  fs.writeFileSync(sigFile, sig);
  return { tar, sigFile };
}

function writeSeaConfig(bundle, tar, sigFile) {
  const cfg = {
    main: bundle,
    output: path.join(OUT, 'sea-prep.blob'),
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
  const bin = path.join(OUT, 'clode');
  // Robust copy: fs.copyFileSync uses copy_file_range on Linux, which returns EIO on
  // some filesystems (autofs / network mounts). A plain read+write avoids it.
  fs.writeFileSync(bin, fs.readFileSync(process.execPath)); // embed THIS node
  fs.chmodSync(bin, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', bin]);
  const postject = path.join(REPO, 'build', 'node_modules', '.bin', 'postject');
  const args = [bin, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(postject, args, { stdio: 'inherit' });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', bin]); // ad-hoc; required or it won't run
  return bin;
}

// Fail the build loudly if the produced binary doesn't actually run. The classic
// failure is a STRIPPED embedded node: postject can't inject into a stripped binary
// without corrupting the ELF, and the dynamic loader then segfaults at startup — a
// runtime-only symptom we catch here at build time.
function smokeCheck(bin) {
  const r = spawnSync(bin, ['--clode-version'], { encoding: 'utf8' });
  if (r.status === 0 && /^clode \d+\.\d+\.\d+/.test(r.stdout || '')) return;
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

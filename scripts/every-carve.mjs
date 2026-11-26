#!/usr/bin/env node
// every-carve -- carve EVERY platform upstream publishes for one version and say what the shim does not account for.
//
//   node scripts/every-carve.mjs --version <x.y.z | pin> [--cache DIR]
//
// Run it before bumping the pin (UPSTREAM_PIN says so); upstream-drift.yml runs it daily for `next`. Downloads are
// sha256-verified against the version's manifest and kept under DIR (default: clode's cache dir, upstream-carves/),
// so a second run costs only the carves (~4s each). Exit 0: every platform measured and accounted for; 1 otherwise,
// naming each platform and member (scripts/lib/every-carve.cjs).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { everyCarveVerdict } = require('./lib/every-carve.cjs');
const { releasesUrl, binaryFor } = require('../libexec/clode-update.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
let version = arg('--version');
if (!version) { process.stderr.write('usage: node scripts/every-carve.mjs --version <x.y.z | pin> [--cache DIR]\n'); process.exit(2); }
if (version === 'pin') version = require('../libexec/upstream-pin.cjs').upstreamPin(REPO);
const cache = path.join(arg('--cache') || path.join(clodeCacheDir(process.env), 'upstream-carves'), version);
const base = `${releasesUrl(process.env)}/${version}`;

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function get(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}

const manifestPath = path.join(cache, 'manifest.json');
if (!fs.existsSync(manifestPath)) await get(`${base}/manifest.json`, manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const platforms = manifest.platforms || manifest;
const results = [];
for (const [platform, entry] of Object.entries(platforms)) {
  try {
    const name = binaryFor(JSON.stringify(manifest), platform);   // claude.exe on win32: the manifest says
    const bin = path.join(cache, platform, name);
    if (!fs.existsSync(bin) || sha256(bin) !== entry.checksum) {
      process.stderr.write(`every-carve: downloading ${platform} ...\n`);
      await get(`${base}/${platform}/${name}`, bin);
      if (sha256(bin) !== entry.checksum) throw new Error(`sha256 mismatch against ${base}/manifest.json`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'every-carve-'));
    try {
      const cli = path.join(tmp, 'cli.cjs');
      const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (ex.status !== 0) throw new Error(`could not carve: ${(ex.stderr || '').trim().split('\n').pop()}`);
      results.push({ platform, text: fs.readFileSync(cli, 'latin1') });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) { results.push({ platform, error: e.message }); }
}
const v = everyCarveVerdict(results);
process.stdout.write(`every-carve ${version}:\n${v.lines.map((l) => `  ${l}`).join('\n')}\n`);
if (!v.ok) process.stdout.write('Decide each unaccounted member: implement it in libexec/bun-shim.cjs, or record it in '
  + 'libexec/inspect-claude-bundle.cjs KNOWN_BUN_ANT with the call site measured on that carve.\n');
process.exit(v.ok ? 0 : 1);

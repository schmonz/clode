#!/usr/bin/env node
// Assemble the clode templates manifest from the bare tjs engines the matrix
// publishes. The manifest is the source of truth clode reads for `build
// --list-targets` and `build --target Y` (libexec/clode-templates.cjs). This
// packages engines the matrix ALREADY builds from source — no rebuild, no
// compiler here. Pure `buildManifest` is unit-tested; the CLI wrapper globs an
// engines dir + reads sidecars in CI. Spec: docs/superpowers/specs/
// 2026-07-25-universal-cross-build-compiler-free-quaude-design.md.
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// inputs: [{ name, tag, engine, file, verified }] — name = target key (e.g.
// 'linux-x64'), tag = platform-tag, engine = published asset filename, file =
// local path to the engine bytes, verified = 'smoke'|'attest-only'|'unverified'.
export function buildManifest({ tjsPin, inputs, compression }) {
  const targets = {};
  for (const it of inputs) {
    // sha256 of the DECOMPRESSED engine (it.file) — the integrity target clode
    // verifies AFTER inflating, independent of how the asset ships on the wire.
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(it.file)).digest('hex');
    targets[it.name] = { tag: it.tag, engine: it.engine, sha256, verified: it.verified || 'unknown' };
  }
  const manifest = { schema: 1, tjsPin, targets };
  // Engines ship gzip'd (asset = <engine>.gz); absent = raw (backward compatible).
  if (compression) manifest.compression = compression;
  return manifest;
}

// --- CI aggregator: turn the matrix's per-leg bare-engine artifacts into
// manifest inputs, using the leg descriptor (scripts/tjs-legs.mjs) as the ONE
// source of truth for which platforms are real targets and how each was
// verified. No build-leg change needed — every leg already uploads its bare
// engine as `tjs-<leg>`; this maps those to the pack. ---
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legsFor } from './tjs-legs.mjs';

// The manifest target key is the platform, not the build recipe: for a given
// OS+arch we build BOTH a glibc validation twin and the musl-static artifact we
// actually ship (linux-x64-glibc vs linux-x64-musl). Only the libc suffix is
// stripped — arch tails like -sparc64/-m68k are the platform.
export function cleanTargetName(legName) {
  return legName.replace(/-(musl|glibc)$/, '');
}

// How much we trust an engine, from what the leg did with it:
//   smoke  — built AND ran the product (full pipeline) on the target
//   version — booted the engine, --version only (heavy qemu-user arches)
//   attest-only — never executed here (no-exec cross: arch/floor-gated only)
//   emulated — ran under emulation, may flake
export function deriveVerified(leg) {
  if (leg['no-exec']) return 'attest-only';
  // A pack-only engine (pack && !publish, i.e. the darwin slices): the engine is
  // real and pre-signed, but CI never fuses-and-runs the PRODUCT on a Mac (the
  // slice job builds the universal, it doesn't smoke a fused quaude), so a
  // cross-built --target darwin-* is attested, not product-verified here.
  if (leg.pack && !leg.publish) return 'attest-only';
  if (leg.smoke === 'version') return 'version';
  if (leg['soft-fail']) return 'emulated';
  return 'smoke';
}

function platOf(leg) {
  const gp = leg['guest-platform'];
  if (!gp || gp === 'native') return leg.leg.split('-')[0];
  if (gp === 'alpine') return 'linux';
  const m = gp.match(/^qemu-([a-z0-9]+)/);
  if (m) return m[1];
  return gp;
}
function archOf(leg) {
  return leg['guest-arch'] || leg['macos-arch'] || leg.leg.split('-').slice(1).join('-');
}

// Human-readable platform identity for `clode build --list-targets`:
// <platform>[-<floor>]-<arch>, e.g. netbsd-10.1-sparc, linux-x86_64.
export function deriveTag(leg) {
  const plat = platOf(leg);
  const arch = archOf(leg);
  return leg.floor ? `${plat}-${leg.floor}-${arch}` : `${plat}-${arch}`;
}

// Same derivation as clode's thisTjsPin (libexec/clode-fuse.cjs): the published
// pin MUST equal what a fetching clode computes, or obtainEngine refuses the pack.
export function tjsPinFromPins(text) {
  const m = text.match(/txiki\.js\s+(v[0-9.]+)\s+([0-9a-f]{7,})/i);
  return m ? `${m[1]}-${m[2].slice(0, 7)}` : null;
}

// The real cross-build targets: legs that either PUBLISH a standalone builder
// asset (publish:true) OR are pack-only engine targets (pack:true) — the darwin
// slices ship their builder via the universal binary (publish:false) but their
// pre-signed engines are perfectly good cross-build --targets. Release tier is
// the deterministic source of truth (the ci tier strips publish). Returned as an
// object keyed by leg name for O(1) artifact lookup.
export function manifestTargets(tier = 'release') {
  const out = {};
  for (const leg of legsFor(tier)) if (leg.publish || leg.pack) out[leg.leg] = leg;
  return out;
}

// Map a directory of downloaded `tjs-<leg>/` artifacts (actions/download-artifact
// with no name = one subdir per artifact) to buildManifest inputs. Artifacts for
// non-target legs (validation twins) or non-engine artifacts (builders) are
// skipped, not errors — a subset dispatch produces a subset pack.
export function collectInputs(enginesDir, targetsByLeg, pin) {
  const inputs = [];
  const skipped = [];
  for (const ent of fs.readdirSync(enginesDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ent.name.startsWith('tjs-')) continue;
    const leg = ent.name.slice('tjs-'.length);
    const spec = targetsByLeg[leg];
    const dir = path.join(enginesDir, ent.name);
    const file = ['tjs', 'tjs.exe'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!spec || !file) { skipped.push(leg); continue; }
    const name = cleanTargetName(leg);
    inputs.push({
      name,
      tag: deriveTag(spec),
      engine: `tjs-${name}-${pin}`,
      file,
      verified: deriveVerified(spec),
    });
  }
  return { inputs, skipped };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

// CLI: build-templates-manifest.mjs --engines DIR --out FILE [--pin P] [--pack DIR] [--tier release]
// Assembles the manifest from downloaded leg engines; with --pack, also stages
// the engines under their pin-versioned pack names + the manifest into one dir
// for a single release upload.
function main(argv) {
  const a = parseArgs(argv);
  if (!a.engines || !a.out) {
    process.stderr.write('usage: --engines DIR --out FILE [--pin P] [--pack DIR] [--tier release|ci]\n');
    process.exit(2);
  }
  const pin = a.pin || tjsPinFromPins(fs.readFileSync(a.pins || 'spike/quickjs/PINS.md', 'utf8'));
  if (!pin) { process.stderr.write('cannot derive tjs pin (pass --pin or provide PINS.md)\n'); process.exit(1); }
  const targets = manifestTargets(a.tier || 'release');
  const { inputs, skipped } = collectInputs(a.engines, targets, pin);
  // Packing implies gzip'd engine assets (the shipping format) — declare it in the
  // manifest so a fetching clode knows to request <engine>.gz and inflate it.
  const gzipPack = !!a.pack;
  const manifest = buildManifest({ tjsPin: pin, inputs, compression: gzipPack ? 'gzip' : undefined });
  fs.writeFileSync(a.out, JSON.stringify(manifest, null, 2) + '\n');
  if (a.pack) {
    fs.mkdirSync(a.pack, { recursive: true });
    for (const it of inputs) {
      const gz = zlib.gzipSync(fs.readFileSync(it.file), { level: 9 });
      fs.writeFileSync(path.join(a.pack, `${it.engine}.gz`), gz);
    }
    fs.writeFileSync(path.join(a.pack, `templates-${pin}.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
  process.stderr.write(`manifest: pin=${pin}, ${inputs.length} target(s)` +
    (gzipPack ? ', gzip' : '') +
    (skipped.length ? `, skipped ${skipped.length}: ${skipped.join(', ')}` : '') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

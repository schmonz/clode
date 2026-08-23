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
import { recipe as engineRecipe, worktreeSource } from './engine-recipe.mjs';

// inputs: [{ name, tag, engine, file, verified }] — name = target key (e.g.
// 'linux-x64'), tag = platform-tag, engine = published asset filename, file =
// local path to the engine bytes, verified = 'smoke'|'attest-only'|'unverified'.
export function buildManifest({ tjsPin, inputs, compression, blob, slices, recipe }) {
  const targets = {};
  for (const it of inputs) {
    // sha256 of the DECOMPRESSED engine (it.file) — the integrity target clode
    // verifies AFTER inflating, independent of how the asset ships on the wire.
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(it.file)).digest('hex');
    targets[it.name] = { tag: it.tag, engine: it.engine, sha256, verified: it.verified || 'unknown' };
    // Schema 2 (blob pack): where this engine's gzip member lives inside the one
    // published blob. Both are REQUIRED when a blob is declared — a target
    // without a slice is unreachable, so emitting one silently would ship a
    // manifest that lies about what it can build.
    if (blob) {
      const s = slices && slices[it.name];
      if (!s) throw new Error(`buildManifest: blob pack is missing a slice for target '${it.name}'`);
      targets[it.name].offset = s.offset;
      targets[it.name].length = s.length;
    }
  }
  // schema 2 == "targets carry {offset,length} into `blob`". A clode reads ITS
  // OWN pin's manifest, so schema-1 (loose per-engine assets) and schema-2 (one
  // range-fetchable blob) coexist by pin with no flag day — an older clode never
  // sees a newer manifest. See docs/superpowers/specs/2026-07-27-release-
  // followups-design.md, "Follow-up 5".
  const manifest = blob ? { schema: 2, tjsPin, blob, targets } : { schema: 1, tjsPin, targets };
  // THE ENGINE RECIPE THESE TEMPLATES WERE BUILT FROM. Without it,
  // scripts/templates-drift.mjs cannot know what the published engines are made
  // of and must DERIVE the recipe from the release tag's tree instead --
  // assuming the engines were built from the sources at that tag. That is a
  // proxy, not a fact, and it is the weaker half of the check: cutting a
  // release turns the drift gate green by assumption, and a republish from a
  // different commit resets the clock silently. Stamping the recipe makes the
  // green EVIDENCE. templates-drift already prefers this field the moment it
  // appears (scripts/templates-drift.mjs:142-144), so this needs no flag day:
  // an older manifest keeps the derivation path, a newer one states its own.
  if (recipe) manifest.recipe = recipe;
  // Engines ship gzip'd (asset = <engine>.gz, or a gzip member inside the blob);
  // absent = raw (backward compatible).
  if (compression) manifest.compression = compression;
  return manifest;
}

// Concatenate each input's gzip'd engine into ONE blob, recording where each
// member starts and how long it is.
//
// WHY A BYTE SLICE IS ENOUGH: every member is an INDEPENDENT gzip stream (its
// own header, deflate data, and CRC/ISIZE trailer), so bytes [offset, offset+len)
// are a complete, self-contained .gz — inflatable by the existing gunzipBuffer
// path with no framing format of our own to parse, and no change to the
// integrity story (sha256 is still of the DECOMPRESSED engine, verified after
// inflation). Concatenated gzip members are also valid as a single stream per
// RFC 1952, so the whole blob happens to gunzip to every engine end-to-end —
// which is a useful property for a human debugging it, not something clode relies on.
export function packBlob(inputs, { level = 9 } = {}) {
  const parts = [];
  const slices = {};
  let offset = 0;
  // Sort by target name so the blob is DETERMINISTIC: the same engines must
  // produce byte-identical output, or a re-run churns the asset and every
  // recorded offset for no reason.
  for (const it of [...inputs].sort((a, b) => a.name.localeCompare(b.name))) {
    const gz = zlib.gzipSync(fs.readFileSync(it.file), { level });
    parts.push(gz);
    slices[it.name] = { offset, length: gz.length };
    offset += gz.length;
  }
  return { blob: Buffer.concat(parts), slices };
}

// --- CI aggregator: turn the matrix's per-leg bare-engine artifacts into
// manifest inputs, using the leg descriptor (scripts/tjs-legs.mjs) as the ONE
// source of truth for which platforms are real targets and how each was
// verified. No build-leg change needed — every leg already uploads its bare
// engine as `tjs-<leg>`; this maps those to the pack. ---
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legsFor } from './tjs-legs.mjs';
import canon from './canonical-name.cjs';
const { targetName, tagFor } = canon;

// The manifest target key is the platform, not the build recipe: for a given
// OS+arch we build BOTH a glibc validation twin and the musl-static artifact we
// actually ship (linux-x64-glibc vs linux-x64-musl). The libc suffix is dropped and
// the os/arch canonicalized (darwin->macos, x64->amd64) via the canonical-name source
// of truth, so the manifest key == the download asset's os/arch.
export function cleanTargetName(legName) {
  return targetName(legName);
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

// Human-readable platform identity for `clode build --list-targets`. This is the
// SAME builder as the published asset name's tag (canonical os/arch, DASHED floor,
// libc suffix), so `--list-targets` shows exactly the download name minus `clode-<v>-`.
// Derived from the leg TOKEN (not guest-arch/macos-arch, which are native spellings
// like x86_64/aarch64) so the tag stays canonical (amd64/arm64/…).
export function deriveTag(leg) {
  return tagFor(leg.leg, leg.floor);
}

// Same derivation as clode's thisTjsPin (libexec/clode-fuse.cjs) AND build-clode-main's
// baked pin: all three MUST agree or obtainEngine refuses the pack. Pin format is
// `<ver>-<sha7>` — the leading `v` from PINS.md is dropped (matches the engine name
// scheme <engine>-<os>-<arch>-<ver>[-<sha7>]); the txiki source sha is kept because
// tjs is source-built (it nails the tree incl. the quickjs-ng submodule).
// The recipe stamped into the manifest. Computed from the working tree, which in
// the templates-pack job IS the commit the engines were just built from (same
// run, same checkout, same legs).
//
// FAILS LOUDLY rather than omitting the field. A missing recipe is not an error
// templates-drift can see -- it just quietly falls back to deriving one from the
// release tag, which is exactly the weaker check this stamp exists to replace.
// So a tree we cannot compute a recipe for stops the release instead of shipping
// a manifest that cannot prove what it is made of. --recipe overrides (tests);
// --no-recipe is the explicit, loud opt-out.
export function stampRecipe(a, src) {
  if (a['no-recipe']) {
    process.stderr.write('build-templates-manifest: --no-recipe — the manifest will NOT state the engine '
      + 'recipe, so templates-drift must derive one from the release tag. That is an assumption, not '
      + 'evidence. Use only when the recipe genuinely cannot be computed.\n');
    return undefined;
  }
  if (typeof a.recipe === 'string') return a.recipe;
  try {
    return engineRecipe(src || worktreeSource());
  } catch (e) {
    throw new Error('build-templates-manifest: cannot compute the engine recipe for this tree '
      + `(${e.message}). The manifest must state what the published engines were built from; without `
      + 'it the drift gate goes green by assumption. Pass --recipe <sha256> if you know it, or '
      + '--no-recipe to ship an unprovable manifest on purpose.');
  }
}

export function tjsPinFromPins(text) {
  const m = text.match(/txiki\.js\s+v?([0-9.]+)\s+([0-9a-f]{7,})/i);
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
      // Engine asset name comes from the ONE vocabulary (canonical-name.cjs), not a
      // second inline spelling of it. These were byte-identical when this was written
      // (verified across darwin-arm64/darwin-ppc/linux-x64-musl/cosmo) — which is
      // precisely when a duplicate is cheapest to remove and most likely to drift
      // later. `canon.engineName` also owns the universal-leg case (cosmo has no arch).
      engine: canon.engineName('tjs', leg, pin),
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

// CLI: build-templates-manifest.mjs --engines DIR --out FILE [--pin P] [--pack DIR]
//                                   [--loose] [--tier release]
//
// With --pack, stages the release upload into DIR. TWO SHAPES:
//   default  ONE `templates-<pin>` blob (all engines' gzip members concatenated)
//            + `templates-<pin>.json` carrying {offset,length} per target.
//            Two assets total, and `clode build --target X` Range-fetches only
//            its ~2.4MB slice.
//   --loose  the pre-2026-08 shape: one `<engine>.gz` per target (schema 1).
//            Kept because it is the only way to regenerate a schema-1 manifest
//            for comparison, and because a mirror that cannot serve HTTP Range
//            at all would need it. NOT what the release publishes.
function main(argv) {
  const a = parseArgs(argv);
  if (!a.engines || !a.out) {
    process.stderr.write('usage: --engines DIR --out FILE [--pin P] [--pack DIR] [--loose] [--tier release|ci] [--recipe SHA|--no-recipe]\n');
    process.exit(2);
  }
  const pin = a.pin || tjsPinFromPins(fs.readFileSync(a.pins || 'spike/quickjs/PINS.md', 'utf8'));
  if (!pin) { process.stderr.write('cannot derive tjs pin (pass --pin or provide PINS.md)\n'); process.exit(1); }
  const targets = manifestTargets(a.tier || 'release');
  const { inputs, skipped } = collectInputs(a.engines, targets, pin);
  // Packing implies gzip'd engines (the shipping format) — declare it in the
  // manifest so a fetching clode knows to inflate what it pulls.
  const gzipPack = !!a.pack;
  const loose = !!a.loose;

  let manifest;
  let packed = null;
  if (a.pack && !loose) {
    packed = packBlob(inputs);
    manifest = buildManifest({
      tjsPin: pin, inputs, compression: 'gzip',
      blob: `templates-${pin}`, slices: packed.slices, recipe: stampRecipe(a),
    });
  } else {
    manifest = buildManifest({
      tjsPin: pin, inputs, compression: gzipPack ? 'gzip' : undefined, recipe: stampRecipe(a),
    });
  }
  fs.writeFileSync(a.out, JSON.stringify(manifest, null, 2) + '\n');

  if (a.pack) {
    fs.mkdirSync(a.pack, { recursive: true });
    if (packed) {
      fs.writeFileSync(path.join(a.pack, `templates-${pin}`), packed.blob);
    } else {
      for (const it of inputs) {
        const gz = zlib.gzipSync(fs.readFileSync(it.file), { level: 9 });
        fs.writeFileSync(path.join(a.pack, `${it.engine}.gz`), gz);
      }
    }
    fs.writeFileSync(path.join(a.pack, `templates-${pin}.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
  process.stderr.write(`manifest: pin=${pin}, ${inputs.length} target(s)` +
    (gzipPack ? (packed ? `, blob ${packed.blob.length} bytes` : ', gzip loose') : '') +
    (skipped.length ? `, skipped ${skipped.length}: ${skipped.join(', ')}` : '') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

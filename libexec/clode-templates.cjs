'use strict';
// The template manifest: the source of truth for which platforms clode can
// cross-build a quaude for, and where to get each prebuilt tjs engine. Published
// by CI (scripts/build-templates-manifest.mjs) alongside the engines; clode reads
// it for `build --list-targets` and `build --target Y`. The engines are fuse-base
// DATA (never executed on the build host), so a manifest + per-engine fetch is all
// clode needs to cross-build for any target — no compiler. See the universal
// cross-build spec (docs/superpowers/specs/2026-07-25-universal-cross-build-*).
class TemplatesError extends Error {
  constructor(msg) { super(msg); this.name = 'TemplatesError'; this.code = 'CLODE_TEMPLATES'; }
}

function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new TemplatesError(`templates manifest: bad JSON (${e.message})`); }
  if (!m || typeof m !== 'object' || !m.targets || typeof m.targets !== 'object') {
    throw new TemplatesError('templates manifest: missing "targets" object');
  }
  if (!m.tjsPin) throw new TemplatesError('templates manifest: missing "tjsPin"');
  return m;
}

// Sorted list of { name, tag } for `build --list-targets`. The build-time
// verify level (smoke/attest-only/…) is intentionally NOT surfaced here — it's
// low signal for a user choosing a target (the target either exists and is
// pinned+sha-verified at fetch, or it doesn't). It stays in the manifest as
// build metadata.
function listTargets(manifest) {
  return Object.keys(manifest.targets).sort().map((name) => {
    const t = manifest.targets[name];
    return { name, tag: t.tag };
  });
}

function resolveTarget(manifest, name) {
  return Object.prototype.hasOwnProperty.call(manifest.targets, name) ? manifest.targets[name] : null;
}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Resolve a target's engine to a local executable path — pin-check, cache by
// engine name, else fetch + sha256-verify + cache + chmod. `fetch(url)->Promise<Buffer>`
// is injectable (clode-net in production; a stub in tests). NO compiler involved:
// the engine is fuse-base data, not something this host executes.
async function obtainEngine(entry, opts) {
  if (opts.manifestPin !== opts.thisPin) {
    throw new TemplatesError(`templates pin ${opts.manifestPin} != this clode's tjs pin ${opts.thisPin} — download the pack for your clode version`);
  }
  // Engines ship gzip'd (manifest.compression) to shrink the download; the CACHE
  // holds the DECOMPRESSED engine (ready to fuse), and entry.sha256 is that
  // decompressed engine's digest — the integrity gate, verified AFTER inflation,
  // so a wrong decompressor is caught here and never fused.
  const compression = opts.compression || entry.compression || null;
  if (compression && compression !== 'gzip') {
    throw new TemplatesError(`engine ${entry.engine}: unsupported compression '${compression}'`);
  }
  const dest = path.join(opts.cacheDir, entry.engine);
  const verify = (buf) => {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== entry.sha256) throw new TemplatesError(`engine ${entry.engine}: sha256 ${got} != manifest ${entry.sha256}`);
  };
  if (fs.existsSync(dest)) { verify(fs.readFileSync(dest)); return dest; }
  const asset = compression === 'gzip' ? `${entry.engine}.gz` : entry.engine;
  const raw = await opts.fetch((opts.baseUrl || '') + asset);
  let buf;
  if (compression === 'gzip') {
    // Injectable for tests; defaults to the native-CLI-then-DecompressionStream path.
    const gunzip = opts.gunzip || ((b) => require('./clode-net.cjs').gunzipBuffer(b, opts));
    buf = await gunzip(raw);
  } else {
    buf = raw;
  }
  verify(buf);
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, 0o755);
  return dest;
}

module.exports = { parseManifest, listTargets, resolveTarget, obtainEngine, TemplatesError };

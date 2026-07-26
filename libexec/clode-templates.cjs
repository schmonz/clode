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

// Sorted list of { name, tag, verified } for `build --list-targets`.
function listTargets(manifest) {
  return Object.keys(manifest.targets).sort().map((name) => {
    const t = manifest.targets[name];
    return { name, tag: t.tag, verified: t.verified || 'unknown' };
  });
}

function resolveTarget(manifest, name) {
  return Object.prototype.hasOwnProperty.call(manifest.targets, name) ? manifest.targets[name] : null;
}

module.exports = { parseManifest, listTargets, resolveTarget, TemplatesError };

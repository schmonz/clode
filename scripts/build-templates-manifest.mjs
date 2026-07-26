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

// inputs: [{ name, tag, engine, file, verified }] — name = target key (e.g.
// 'linux-x64'), tag = platform-tag, engine = published asset filename, file =
// local path to the engine bytes, verified = 'smoke'|'attest-only'|'unverified'.
export function buildManifest({ tjsPin, inputs }) {
  const targets = {};
  for (const it of inputs) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(it.file)).digest('hex');
    targets[it.name] = { tag: it.tag, engine: it.engine, sha256, verified: it.verified || 'unknown' };
  }
  return { schema: 1, tjsPin, targets };
}

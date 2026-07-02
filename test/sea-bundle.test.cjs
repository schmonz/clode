const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const NODE = process.env.CLODE_NODE || process.execPath;
// Build artifacts live under a per-platform tag dir (build/<os>-<osver>-<arch>-node<major>)
// so a shared build/ tree can host mutually-incompatible builds without collision.
const { seaOut } = require('../scripts/platform-tag.cjs');
const OUT = seaOut(REPO);
const BUNDLE = path.join(OUT, 'clode-main.bundle.cjs');

// The SEA build toolchain (esbuild) is installed INTO the per-tag dir on demand by
// build-sea.mjs (from build/package.json) — NOT the repo root. Skip cleanly when it
// isn't installed yet so the normal suite is never forced to build a SEA bundle.
const ESBUILD = path.join(OUT, 'node_modules', '.bin', 'esbuild');
const haveBuildDeps = fs.existsSync(ESBUILD);

test('esbuild produces a self-contained clode-main bundle that runs as node', (t) => {
  if (!haveBuildDeps) {
    t.skip('SEA build deps absent (run: npm install --prefix build)');
    return;
  }
  // The build script must produce the bundle from libexec/clode-main.cjs + its graph.
  const b = spawnSync(NODE, [path.join(REPO, 'scripts', 'build-sea.mjs'), '--bundle-only'],
    { encoding: 'utf8', cwd: REPO });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(fs.existsSync(BUNDLE), 'bundle not produced');
  // It behaves like clode-main: --clode-version prints the version, no missing-module error.
  const r = spawnSync(NODE, [BUNDLE, '--clode-version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^clode \d+\.\d+\.\d+/);
  assert.doesNotMatch(r.stderr, /Cannot find module/);
});

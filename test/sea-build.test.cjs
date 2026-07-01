'use strict';
// Task 5: the full build pipeline produces a runnable SEA binary. Gated to this host
// (linux-x64, node >= 24) with the build deps installed; skips cleanly elsewhere so
// the normal suite is never forced to build a SEA.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'build', 'sea', 'clode');
const ESBUILD = path.join(REPO, 'build', 'node_modules', '.bin', 'esbuild');

// Building a SEA is expensive AND embeds the building node — which must be an official
// (non-stripped) Node, or postject corrupts it. So this is opt-in (CLODE_SEA=1) and
// builds with CLODE_SEA_NODE (an official node, e.g. an asdf install) when given.
const BUILD_NODE = process.env.CLODE_SEA_NODE || process.execPath;
const canBuild =
  process.env.CLODE_SEA === '1' && process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(ESBUILD);

test('build-sea.mjs produces a runnable SEA binary that reports the version', { timeout: 300000 }, (t) => {
  if (!canBuild) {
    t.skip('SEA build opt-in (set CLODE_SEA=1, linux-x64, `npm install --prefix build`, official CLODE_SEA_NODE)');
    return;
  }
  const b = spawnSync(BUILD_NODE, [path.join(REPO, 'scripts', 'build-sea.mjs')], { encoding: 'utf8', cwd: REPO });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(fs.existsSync(BIN), 'SEA binary not produced');
  assert.ok(fs.statSync(BIN).mode & 0o111, 'SEA binary not executable');
  // The binary runs (postject worked): --clode-version exits 0 and prints the version.
  const r = spawnSync(BIN, ['--clode-version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^clode \d+\.\d+\.\d+/);
});

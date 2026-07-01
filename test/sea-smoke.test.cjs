'use strict';
// Task 6: end-to-end smoke of the BUILT SEA binary — it fetches/extracts/runs the
// real bundle with materialized deps + run-as-node. Gated to this host (linux-x64,
// node >= 24) with the build deps installed; builds the binary on demand. Skips
// cleanly elsewhere so the normal suite never has to build a SEA.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'build', 'sea', 'clode');
const ESBUILD = path.join(REPO, 'build', 'node_modules', '.bin', 'esbuild');

// Opt-in (CLODE_SEA=1); builds on demand with CLODE_SEA_NODE (an official, non-stripped
// node — a distro-stripped node segfaults once postject injects the blob).
const BUILD_NODE = process.env.CLODE_SEA_NODE || process.execPath;
const canBuild =
  process.env.CLODE_SEA === '1' && process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(ESBUILD);

// A provider the built binary can extract/run (offline). Prefer an explicit override,
// else the host's claude wrapper. null -> the bundle-boot tests skip.
function hostProvider() {
  if (process.env.CLODE_CLAUDE_BIN) return process.env.CLODE_CLAUDE_BIN;
  for (const p of ['/usr/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

before(() => {
  if (!canBuild) return;
  if (!fs.existsSync(BIN)) {
    const b = spawnSync(BUILD_NODE, [path.join(REPO, 'scripts', 'build-sea.mjs')],
      { encoding: 'utf8', cwd: REPO, timeout: 300000 });
    assert.strictEqual(b.status, 0, 'SEA build failed: ' + b.stderr);
  }
});

// Hermetic env for a boot: private cache + a resolvable provider, no ambient CLODE_*.
function bootEnv(cacheDir, provider) {
  const env = { ...process.env };
  delete env.CLODE_OFFLINE;
  env.CLODE_CACHE = cacheDir;
  env.CLODE_CLAUDE_BIN = provider;
  return env;
}

test('SEA --clode-version prints the version', (t) => {
  if (!canBuild) { t.skip('SEA build not supported here'); return; }
  const r = spawnSync(BIN, ['--clode-version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^clode \d+\.\d+\.\d+/);
});

test('SEA --clode-help mentions --clode-watch', (t) => {
  if (!canBuild) { t.skip('SEA build not supported here'); return; }
  const r = spawnSync(BIN, ['--clode-help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--clode-watch/);
});

test('SEA --version boots the real bundle (extract + materialize + run-as-node)', (t) => {
  if (!canBuild) { t.skip('SEA build not supported here'); return; }
  const provider = hostProvider();
  if (!provider) { t.skip('no provider binary resolvable (set CLODE_CLAUDE_BIN)'); return; }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-cache-'));
  try {
    const r = spawnSync(BIN, ['--version'], { encoding: 'utf8', env: bootEnv(cache, provider), timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    // Claude Code's --version prints a version line; just prove it booted and printed one.
    assert.match(r.stdout, /\d+\.\d+\.\d+/, 'bundle did not print a version: ' + r.stdout);
    assert.doesNotMatch(r.stderr, /Cannot find module|MODULE_NOT_FOUND/, r.stderr);
    // Assets were materialized from the embedded blob (not npm/libexec): a sig-keyed
    // depsRoot holding node_modules, plus a libexec dir with the shim + extractor.
    const seaDeps = path.join(cache, 'sea-deps');
    const entries = fs.existsSync(seaDeps) ? fs.readdirSync(seaDeps) : [];
    const sigDir = entries.find((d) => fs.existsSync(path.join(seaDeps, d, 'node_modules')));
    assert.ok(sigDir, 'materialized sea-deps/<sig>/node_modules missing');
    assert.ok(fs.existsSync(path.join(seaDeps, 'libexec', 'bun-shim.cjs')), 'materialized bun-shim missing');
    assert.ok(fs.existsSync(path.join(seaDeps, 'libexec', 'extract-claude-js.cjs')), 'materialized extractor missing');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('SEA reuses sea-deps/<sig> across runs (idempotent materialize)', (t) => {
  if (!canBuild) { t.skip('SEA build not supported here'); return; }
  const provider = hostProvider();
  if (!provider) { t.skip('no provider binary resolvable'); return; }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-cache-'));
  try {
    const env = bootEnv(cache, provider);
    let r = spawnSync(BIN, ['--version'], { encoding: 'utf8', env, timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const seaDeps = path.join(cache, 'sea-deps');
    const sig = fs.readdirSync(seaDeps).find((d) => fs.existsSync(path.join(seaDeps, d, 'node_modules')));
    const marker = path.join(seaDeps, sig, 'node_modules');
    const mtime1 = fs.statSync(marker).mtimeMs;
    r = spawnSync(BIN, ['--version'], { encoding: 'utf8', env, timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.statSync(marker).mtimeMs, mtime1, 're-materialized despite existing sea-deps');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('SEA -p round-trips through the model (PONG)', (t) => {
  if (!canBuild) { t.skip('SEA build not supported here'); return; }
  if (process.env.CLODE_OFFLINE) { t.skip('online test (unset CLODE_OFFLINE to run)'); return; }
  const provider = hostProvider();
  if (!provider) { t.skip('no provider binary resolvable'); return; }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-cache-'));
  try {
    const r = spawnSync(BIN, ['-p', 'reply with exactly: PONG'],
      { encoding: 'utf8', env: bootEnv(cache, provider), timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /PONG/, 'model round-trip failed: ' + r.stdout);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

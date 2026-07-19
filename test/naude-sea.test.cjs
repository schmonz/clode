'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSea, materializeAssets, materializeDeps } = require('../libexec/naude-sea.cjs');

// A fake SEA: getRawAsset returns ArrayBuffers for a fixed asset map. No real SEA.
function fakeSea(map) {
  return {
    isSea: () => true,
    getRawAsset: (name) => {
      if (!(name in map)) throw new Error('no asset ' + name);
      const b = Buffer.from(map[name]);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

test('isSea is false (never throws) under a hostile sea object', () => {
  assert.strictEqual(isSea({ get isSea() { throw new Error('boom'); } }), false);
  assert.strictEqual(isSea(null), false);
});

test('materializeAssets writes the named assets to destDir, mtime-stable', () => {
  const sea = fakeSea({ 'cli.cjs': 'CLI-BODY', 'bun-shim.cjs': 'SHIM-BODY' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-mat-'));
  materializeAssets({ sea, destDir: dir, names: ['cli.cjs', 'bun-shim.cjs'] });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cli.cjs'), 'utf8'), 'CLI-BODY');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bun-shim.cjs'), 'utf8'), 'SHIM-BODY');
  const m1 = fs.statSync(path.join(dir, 'cli.cjs')).mtimeMs;
  materializeAssets({ sea, destDir: dir, names: ['cli.cjs', 'bun-shim.cjs'] });
  assert.strictEqual(fs.statSync(path.join(dir, 'cli.cjs')).mtimeMs, m1);
});

test('materializeDeps resolves tar via provision (uses a real tar binary)', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-'));
  // Build a real tar payload with a node_modules marker + a sig asset.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-stage-'));
  fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'node_modules', '.marker'), 'x');
  const tarBuf = require('node:child_process')
    .spawnSync('tar', ['-cf', '-', '-C', staging, 'node_modules'], { maxBuffer: 1 << 30 }).stdout;
  const fakeSea = {}; // matches naude-sea's seaMod() shape used by assetBuffer
  const assets = { 'deps.tar': tarBuf, 'deps.sig': Buffer.from('kat-sig\n') };
  const calls = [];
  const dir = materializeDeps({
    sea: fakeSea,
    cacheDir,
    assetBuffer: (_sea, name) => assets[name], // injected asset accessor
    spawn: (bin, args, o) => { calls.push(bin); return require('node:child_process').spawnSync(bin, args, o); },
    // Isolate provision('tar')'s hosttools.json cache to this test's tmpdir (CLODE_STATE_ROOT),
    // matching host-provision.test.cjs's dataDir isolation — never read/write the real
    // ~/.local/share/clode/hosttools.json from a test.
    env: { ...process.env, CLODE_STATE_ROOT: cacheDir },
  });
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', '.marker')), 'deps extracted');
  assert.ok(calls.some((b) => /tar|gtar|bsdtar/.test(b)), 'used a provisioned tar');
});

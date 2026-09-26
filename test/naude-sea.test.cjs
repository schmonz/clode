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
  assert.ok(calls.some((b) => path.isAbsolute(b) && /tar|gtar|bsdtar/.test(b)),
    'used a provision-resolved (absolute) tar path');
});

// THE OS TEMP CLEANER (measured 2026-09-26). cacheDir defaults to os.tmpdir(), and macOS's
// periodic temp cleaner deleted every FILE under $TMPDIR/sea-deps/<sig>/node_modules -- 21
// package directories left, not one file in them -- four days after they were unpacked. The
// old check (node_modules/ exists) never unpacked again, and every naude died "ws ... isn't
// installed" at the bundle's first require('ws'). Unpacking must notice that and redo it, and
// must still reuse a tree that is whole.
function unpackFixture() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-purge-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-stage-'));
  for (const [pkg, file] of [['ws', 'index.js'], ['semver', 'index.js'], ['@scope/pkg', 'main.js']]) {
    fs.mkdirSync(path.join(staging, 'node_modules', pkg, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'node_modules', pkg, 'package.json'), `{"name":"${pkg}"}`);
    fs.writeFileSync(path.join(staging, 'node_modules', pkg, 'lib', file), `// ${pkg}`);
  }
  const tarBuf = require('node:child_process')
    .spawnSync('tar', ['-cf', '-', '-C', staging, 'node_modules'], { maxBuffer: 1 << 30 }).stdout;
  fs.rmSync(staging, { recursive: true, force: true });
  const assets = { 'deps.tar': tarBuf, 'deps.sig': Buffer.from('purge-sig\n') };
  const tars = [];
  const unpack = () => materializeDeps({
    sea: {}, cacheDir,
    assetBuffer: (_sea, name) => assets[name],
    // Only extractions of THIS tarball count: provision('tar') also runs tar, for its
    // known-answer test.
    spawn: (bin, args, o) => { if (o && o.input === assets['deps.tar']) tars.push(bin); return require('node:child_process').spawnSync(bin, args, o); },
    env: { ...process.env, CLODE_STATE_ROOT: cacheDir },
  });
  return { cacheDir, unpack, tars };
}

// Every file under `dir`, deleted; every directory kept: what the cleaner left.
function purgeFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) purgeFiles(p); else fs.rmSync(p);
  }
}

test('materializeDeps reuses a whole unpacked tree without running tar again', () => {
  const { cacheDir, unpack, tars } = unpackFixture();
  try {
    const dir = unpack();
    assert.strictEqual(unpack(), dir);
    assert.strictEqual(tars.length, 1, 'the second launch found the tree whole and did not unpack');
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('materializeDeps unpacks again when the temp cleaner emptied the tree but left its directories', () => {
  const { cacheDir, unpack, tars } = unpackFixture();
  try {
    const dir = unpack();
    purgeFiles(dir);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'ws')), 'the purge leaves the directories');
    assert.strictEqual(unpack(), dir);
    assert.strictEqual(tars.length, 2, 'the purged tree was unpacked again');
    for (const p of ['ws/package.json', 'ws/lib/index.js', 'semver/lib/index.js', '@scope/pkg/lib/main.js']) {
      assert.ok(fs.existsSync(path.join(dir, 'node_modules', p)), `${p} is back`);
    }
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('materializeDeps unpacks again when a whole package is gone from the tree', () => {
  const { cacheDir, unpack, tars } = unpackFixture();
  try {
    const dir = unpack();
    fs.rmSync(path.join(dir, 'node_modules', 'ws'), { recursive: true });
    unpack();
    assert.strictEqual(tars.length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'ws', 'package.json')), 'ws is back');
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

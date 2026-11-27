'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSea, materializeAssets, materializeDeps } = require('../libexec/naude-sea.cjs');
const { packTar } = require('../scripts/tar-pack.cjs');

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

test('materializeDeps unpacks deps.tar in process, keeping modes and symlinks, with no tar on PATH', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-sea-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-stage-'));
  fs.mkdirSync(path.join(staging, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'node_modules', '.marker'), 'x');
  fs.writeFileSync(path.join(staging, 'node_modules', 'cli.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(staging, 'node_modules', 'cli.js'), 0o755);
  const canLink = process.platform !== 'win32';
  if (canLink) fs.symlinkSync('../cli.js', path.join(staging, 'node_modules', '.bin', 'cli'));
  // The SAME packer build-naude.mjs uses for the real deps.tar.
  const tarBuf = packTar(staging, ['node_modules']);
  const assets = { 'deps.tar': tarBuf, 'deps.sig': Buffer.from('kat-sig\n') };
  const savedPath = process.env.PATH;
  process.env.PATH = '';   // no host tar can be what extracts it
  let dir;
  try {
    dir = materializeDeps({ sea: {}, cacheDir, assetBuffer: (_sea, name) => assets[name] });
  } finally { process.env.PATH = savedPath; }
  assert.strictEqual(fs.readFileSync(path.join(dir, 'node_modules', '.marker'), 'utf8'), 'x');
  if (canLink) {
    assert.strictEqual(fs.statSync(path.join(dir, 'node_modules', 'cli.js')).mode & 0o111, 0o111, 'the executable bit survived');
    assert.strictEqual(fs.readlinkSync(path.join(dir, 'node_modules', '.bin', 'cli')), '../cli.js', 'the symlink survived');
  }
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
  const tarBuf = packTar(staging, ['node_modules']);
  fs.rmSync(staging, { recursive: true, force: true });
  const assets = { 'deps.tar': tarBuf, 'deps.sig': Buffer.from('purge-sig\n') };
  const tars = [];   // one per unpack: the tarball is read only to extract it
  const unpack = () => materializeDeps({
    sea: {}, cacheDir,
    assetBuffer: (_sea, name) => { if (name === 'deps.tar') tars.push(name); return assets[name]; },
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

test('materializeDeps reuses a whole unpacked tree without unpacking again', () => {
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

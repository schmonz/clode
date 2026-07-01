'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sea = require('../libexec/clode-sea.cjs');

// Build a tiny REAL tar (node_modules/fake/index.js) so materializeDeps' unpack is real.
function makeDepsTar(tmp) {
  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(stage, 'node_modules', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'node_modules', 'fake', 'index.js'), 'module.exports = 42;\n');
  const tar = path.join(tmp, 'deps.tar');
  execFileSync('tar', ['-cf', tar, '-C', stage, 'node_modules']);
  return fs.readFileSync(tar);
}

// A fake SEA whose getRawAsset serves an in-memory asset map (Buffers/ArrayBuffers).
function fakeSea(assets, seaFlag = true) {
  return { isSea: () => seaFlag, getRawAsset: (n) => assets[n] };
}

test('isSea reflects the injected sea', () => {
  assert.strictEqual(sea.isSea(fakeSea({}, true)), true);
  assert.strictEqual(sea.isSea(fakeSea({}, false)), false);
  assert.strictEqual(sea.isSea(null), false);
});

test('materializeDeps unpacks the tar into sea-deps/<sig>/node_modules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seadeps-'));
  try {
    const tarBuf = makeDepsTar(tmp);
    const s = fakeSea({ 'deps.sig': Buffer.from('sig-abc\n'), 'deps.tar': tarBuf });
    const cacheDir = path.join(tmp, 'cache');
    const nm = sea.materializeDeps({ sea: s, cacheDir });
    assert.strictEqual(nm, path.join(cacheDir, 'sea-deps', 'sig-abc', 'node_modules'));
    assert.ok(fs.existsSync(path.join(nm, 'fake', 'index.js')), 'unpacked file missing');
    assert.strictEqual(require(path.join(nm, 'fake')), 42);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeDeps is idempotent (same sig -> no re-unpack)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seadeps-'));
  try {
    const tarBuf = makeDepsTar(tmp);
    const s = fakeSea({ 'deps.sig': Buffer.from('sig-xyz'), 'deps.tar': tarBuf });
    const cacheDir = path.join(tmp, 'cache');
    const nm1 = sea.materializeDeps({ sea: s, cacheDir });
    const marker = path.join(nm1, 'fake', 'index.js');
    const mtime1 = fs.statSync(marker).mtimeMs;
    // Second call: if it re-unpacked, getRawAsset('deps.tar') would run again and the
    // dir would be rewritten. Prove it does NOT by breaking deps.tar and asserting the
    // file is untouched (same mtime, still present).
    const s2 = fakeSea({ 'deps.sig': Buffer.from('sig-xyz'), 'deps.tar': Buffer.from('CORRUPT') });
    const nm2 = sea.materializeDeps({ sea: s2, cacheDir });
    assert.strictEqual(nm2, nm1);
    assert.strictEqual(fs.statSync(marker).mtimeMs, mtime1, 're-unpacked despite existing dir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeDeps accepts an ArrayBuffer asset (real getRawAsset shape)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seadeps-'));
  try {
    const tarBuf = makeDepsTar(tmp);
    // getRawAsset returns ArrayBuffer for binary assets; assetBuffer must Buffer.from it.
    const ab = tarBuf.buffer.slice(tarBuf.byteOffset, tarBuf.byteOffset + tarBuf.byteLength);
    const s = fakeSea({ 'deps.sig': Buffer.from('sig-ab'), 'deps.tar': ab });
    const cacheDir = path.join(tmp, 'cache');
    const nm = sea.materializeDeps({ sea: s, cacheDir });
    assert.ok(fs.existsSync(path.join(nm, 'fake', 'index.js')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeBunShim writes bun-shim.cjs from the asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seashim-'));
  try {
    const s = fakeSea({ 'bun-shim.cjs': Buffer.from('// shim body\n') });
    const destDir = path.join(tmp, 'sea-deps');
    const p = sea.materializeBunShim({ sea: s, destDir });
    assert.strictEqual(p, path.join(destDir, 'bun-shim.cjs'));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '// shim body\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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
  // Archive to stdout with the staging dir as cwd — NO colon-bearing path args, so Git
  // Bash's GNU tar (what `npm test` under `shell: bash` resolves on Windows CI) can't
  // misread a `C:`/`D:` drive letter as a remote `host:path` (mirrors the build-side
  // stageDeps fix, commit 28be5c0). A colon-bearing `-f C:\…\deps.tar` fails there with
  // "tar: Cannot connect to C: resolve failed".
  return execFileSync('tar', ['-cf', '-', 'node_modules'], { cwd: stage, maxBuffer: 64 * 1024 * 1024 });
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

test('materializeDeps unpacks the tar and returns a depsRoot-shaped dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seadeps-'));
  try {
    const tarBuf = makeDepsTar(tmp);
    const s = fakeSea({ 'deps.sig': Buffer.from('sig-abc\n'), 'deps.tar': tarBuf });
    const cacheDir = path.join(tmp, 'cache');
    const depsRoot = sea.materializeDeps({ sea: s, cacheDir });
    // Returns the DIR that CONTAINS node_modules (a DEPS_ROOT), keyed by the sig.
    assert.strictEqual(depsRoot, path.join(cacheDir, 'sea-deps', 'sig-abc'));
    const nm = path.join(depsRoot, 'node_modules');
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
    const d1 = sea.materializeDeps({ sea: s, cacheDir });
    const marker = path.join(d1, 'node_modules', 'fake', 'index.js');
    const mtime1 = fs.statSync(marker).mtimeMs;
    // Second call with a CORRUPT tar proves it does not re-unpack an existing dir.
    const s2 = fakeSea({ 'deps.sig': Buffer.from('sig-xyz'), 'deps.tar': Buffer.from('CORRUPT') });
    const d2 = sea.materializeDeps({ sea: s2, cacheDir });
    assert.strictEqual(d2, d1);
    assert.strictEqual(fs.statSync(marker).mtimeMs, mtime1, 're-unpacked despite existing dir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeDeps accepts an ArrayBuffer asset (real getRawAsset shape)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seadeps-'));
  try {
    const tarBuf = makeDepsTar(tmp);
    const ab = tarBuf.buffer.slice(tarBuf.byteOffset, tarBuf.byteOffset + tarBuf.byteLength);
    const s = fakeSea({ 'deps.sig': Buffer.from('sig-ab'), 'deps.tar': ab });
    const cacheDir = path.join(tmp, 'cache');
    const depsRoot = sea.materializeDeps({ sea: s, cacheDir });
    assert.ok(fs.existsSync(path.join(depsRoot, 'node_modules', 'fake', 'index.js')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeLibexec writes shim + extractor and returns the dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealib-'));
  try {
    const s = fakeSea({
      'bun-shim.cjs': Buffer.from('// shim body\n'),
      'extract-claude-js.cjs': Buffer.from('// extractor body\n'),
    });
    const destDir = path.join(tmp, 'sea-deps', 'libexec');
    const out = sea.materializeLibexec({ sea: s, destDir });
    assert.strictEqual(out, destDir);
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'bun-shim.cjs'), 'utf8'), '// shim body\n');
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'extract-claude-js.cjs'), 'utf8'), '// extractor body\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('materializeLibexec leaves an unchanged file untouched (stable mtime -> stable sig)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealib-'));
  try {
    const assets = {
      'bun-shim.cjs': Buffer.from('// shim\n'),
      'extract-claude-js.cjs': Buffer.from('// extractor\n'),
    };
    const destDir = path.join(tmp, 'libexec');
    sea.materializeLibexec({ sea: fakeSea(assets), destDir });
    const ext = path.join(destDir, 'extract-claude-js.cjs');
    const mtime1 = fs.statSync(ext).mtimeMs;
    sea.materializeLibexec({ sea: fakeSea(assets), destDir });  // same content
    assert.strictEqual(fs.statSync(ext).mtimeMs, mtime1, 'rewrote an unchanged extractor');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

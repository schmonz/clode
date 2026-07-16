'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSea, materializeAssets } = require('../libexec/naude-sea.cjs');

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

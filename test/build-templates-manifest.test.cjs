'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildManifest } = require('../scripts/build-templates-manifest.mjs');

test('buildManifest computes sha256 + shape from engine files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  fs.writeFileSync(path.join(d, 'tjs-linux-x64-11'), 'LX');
  const inputs = [{ name: 'linux-x64', tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-11', file: path.join(d, 'tjs-linux-x64-11'), verified: 'smoke' }];
  const m = buildManifest({ tjsPin: 'v26.6.0-1a230d3', inputs });
  assert.strictEqual(m.schema, 1);
  assert.strictEqual(m.tjsPin, 'v26.6.0-1a230d3');
  assert.strictEqual(m.targets['linux-x64'].tag, 'linux-glibc2.28-x64');
  assert.strictEqual(m.targets['linux-x64'].engine, 'tjs-linux-x64-11');
  assert.strictEqual(m.targets['linux-x64'].verified, 'smoke');
  assert.strictEqual(m.targets['linux-x64'].sha256,
    crypto.createHash('sha256').update('LX').digest('hex'));
});

test('buildManifest defaults verified to "unknown"', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2-'));
  fs.writeFileSync(path.join(d, 'e'), 'x');
  const m = buildManifest({ tjsPin: 'p', inputs: [{ name: 'y', tag: 't', engine: 'e', file: path.join(d, 'e') }] });
  assert.strictEqual(m.targets['y'].verified, 'unknown');
});

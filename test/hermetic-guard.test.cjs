const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./hermetic-guard.cjs');

test('snapshot marks absent vs present and diff detects a new/changed entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  const target = path.join(dir, 'store');
  const before = G.snapshot([target]);
  assert.match(before[0], /\|ABSENT$/);
  fs.mkdirSync(target);
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.strictEqual(changed.length, 1);
  assert.ok(changed[0].includes(target));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diff is empty when nothing changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  const snap = G.snapshot([dir]);
  assert.deepStrictEqual(G.diffSnapshots(snap, G.snapshot([dir])), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

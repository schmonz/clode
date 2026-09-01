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
  // target does not exist yet, so this pins the ABSENT sentinel specifically
  // (distinct from EMPTY, which a since-created-but-empty directory gets instead).
  assert.match(before[0], /\|ABSENT$/);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'f'), 'x');
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0);
  assert.ok(changed.some((l) => l.includes(target)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diff is empty when nothing changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  const snap = G.snapshot([dir]);
  assert.deepStrictEqual(G.diffSnapshots(snap, G.snapshot([dir])), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

const fs2 = require('node:fs');
const os2 = require('node:os');
const path2 = require('node:path');

test('snapshot sees a modification three levels down (was blind)', () => {
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'herm-deep-'));
  fs2.mkdirSync(path2.join(root, 'a', 'b'), { recursive: true });
  const f = path2.join(root, 'a', 'b', 'f.txt');
  fs2.writeFileSync(f, 'one');
  const before = G.snapshot([root]);
  fs2.writeFileSync(f, 'two-is-longer');
  const changed = G.diffSnapshots(before, G.snapshot([root]));
  assert.ok(changed.length > 0, 'deep modification must be reported, got none');
  assert.ok(changed.join('\n').includes('f.txt'), `expected f.txt in: ${changed.join(', ')}`);
});

test('a watched root going from absent to an existing empty directory produces a non-empty diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-empty-'));
  const target = path.join(dir, 'store');
  const before = G.snapshot([target]);
  fs.mkdirSync(target);
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0, 'absent -> existing empty directory must be reported, got none');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a watched root that is a plain file reports a content change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-file-'));
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'one');
  const before = G.snapshot([target]);
  fs.writeFileSync(target, 'two-is-longer');
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0, "a watched file's content change must be reported, got none");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a genuinely absent watched root reports the ABSENT sentinel, distinct from EMPTY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-absent-'));
  const missing = path.join(dir, 'does-not-exist');
  const snap = G.snapshot([missing]);
  assert.match(snap[0], /\|ABSENT$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

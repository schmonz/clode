// test/tree-guard.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('./tree-guard.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tree-guard-')); }

test('walk sees a file nested three levels down', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'deep.txt'), 'x');
  const m = G.walk(root);
  assert.ok(m.has(path.join('a', 'b', 'c', 'deep.txt')),
    `expected the deep file in ${[...m.keys()].join(', ')}`);
});

test('diff reports a deep modification — the blind spot hermetic-guard has', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  const f = path.join(root, 'a', 'b', 'f.txt');
  fs.writeFileSync(f, 'one');
  const before = G.walk(root);
  fs.writeFileSync(f, 'two-is-longer');
  const d = G.diff(before, G.walk(root));
  assert.deepStrictEqual(d, [{ path: path.join('a', 'b', 'f.txt'), kind: 'modified' }]);
});

test('diff reports creations and deletions', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'gone.txt'), 'x');
  const before = G.walk(root);
  fs.rmSync(path.join(root, 'gone.txt'));
  fs.writeFileSync(path.join(root, 'new.txt'), 'y');
  assert.deepStrictEqual(G.diff(before, G.walk(root)), [
    { path: 'gone.txt', kind: 'deleted' },
    { path: 'new.txt', kind: 'created' },
  ]);
});

test('ignore prefixes are skipped', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'build', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'x', 'art'), 'x');
  fs.writeFileSync(path.join(root, 'kept'), 'x');
  const m = G.walk(root, { ignore: ['build'] });
  assert.deepStrictEqual([...m.keys()], ['kept']);
});

test('walk of a missing root is empty, not a throw', () => {
  assert.strictEqual(G.walk(path.join(tmp(), 'nope')).size, 0);
});

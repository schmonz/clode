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

test('unreadable file is recorded, not silently omitted', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'readable.txt'), 'x');
  fs.writeFileSync(path.join(root, 'denied.txt'), 'y');
  const mockFs = {
    readdirSync: fs.readdirSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    lstatSync: (p) => {
      if (p.endsWith('denied.txt')) {
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.lstatSync(p);
    },
  };
  const m = G.walk(root, { fsm: mockFs });
  assert.ok(m.has('denied.txt'), 'unreadable file should be in the map');
  const entry = m.get('denied.txt');
  assert.ok(entry.startsWith('UNREADABLE|'), `expected UNREADABLE marker, got ${entry}`);
  assert.ok(entry.includes('EACCES'), `expected EACCES in error, got ${entry}`);
});

test('unreadable directory is recorded, not silently omitted', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permission bits are bypassed, so this test cannot deny access');
    return;
  }
  if (process.platform === 'win32') {
    t.skip('win32: permission semantics differ, chmod may not block directory access');
    return;
  }
  const root = tmp();
  const unreadableDir = path.join(root, 'denied-dir');
  fs.mkdirSync(unreadableDir);
  fs.mkdirSync(path.join(unreadableDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(unreadableDir, 'nested', 'deep.txt'), 'x');
  fs.chmodSync(unreadableDir, 0o000);
  const before = G.walk(root);
  // The unreadable directory itself should be recorded
  const entry = before.get('denied-dir');
  assert.ok(entry, 'unreadable directory should be in the map');
  assert.ok(entry.startsWith('UNREADABLE|'), `expected UNREADABLE marker, got ${entry}`);
  // Nested files should not be in the map (can't descend)
  assert.ok(!before.has(path.join('denied-dir', 'nested', 'deep.txt')),
    'nested file should not be visible through unreadable directory');
  // Restore perms so cleanup works
  fs.chmodSync(unreadableDir, 0o755);
});

test('lstatSync records symlink properties, not target properties', () => {
  const root = tmp();
  const targetFile = path.join(root, 'target.txt');
  const linkFile = path.join(root, 'link');
  fs.writeFileSync(targetFile, 'x');
  fs.symlinkSync(targetFile, linkFile);
  const m = G.walk(root);
  assert.ok(m.has('link'), 'symlink should be recorded');
  const linkEntry = m.get('link');
  const targetEntry = m.get('target.txt');
  assert.notStrictEqual(linkEntry, targetEntry,
    'symlink and target should have different metadata');
  // Symlink mode should have S_IFLNK bit set; target should not
  const linkMode = parseInt(linkEntry.split('|')[2]);
  const targetMode = parseInt(targetEntry.split('|')[2]);
  // S_IFLNK is 0o120000; check that link has a different mode type
  assert.notStrictEqual(linkMode & 0o170000, targetMode & 0o170000,
    `link mode type (${linkMode.toString(8)}) should differ from target (${targetMode.toString(8)})`);
});

test('ignore with trailing slash works the same as without', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'build', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'x', 'art'), 'x');
  fs.writeFileSync(path.join(root, 'kept'), 'x');
  const mWithoutSlash = G.walk(root, { ignore: ['build'] });
  const mWithSlash = G.walk(root, { ignore: ['build/'] });
  assert.deepStrictEqual([...mWithoutSlash.keys()], ['kept']);
  assert.deepStrictEqual([...mWithSlash.keys()], ['kept'],
    'trailing slash should be normalized away');
});

test('unreadable walk root is recorded, not indistinguishable from missing/empty', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permission bits are bypassed, so this test cannot deny access');
    return;
  }
  if (process.platform === 'win32') {
    t.skip('win32: permission semantics differ, chmod may not block directory access');
    return;
  }
  const root = tmp();
  fs.chmodSync(root, 0o000);
  const m = G.walk(root);
  // Restore perms so cleanup works
  fs.chmodSync(root, 0o755);
  assert.ok(m.has('.'), 'unreadable root should be recorded under sentinel key "."');
  const entry = m.get('.');
  assert.ok(entry.startsWith('UNREADABLE|'), `expected UNREADABLE marker, got ${entry}`);
});

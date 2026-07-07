'use strict';
// Characterization: shim path/os/url answers must MATCH host node's answers
// for the same inputs (posix). The table runs in both worlds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const TABLE = `
const p = require('node:path');
const u = require('node:url');
const cases = [
  p.join('a', 'b', '..', 'c'), p.join('/x//y/', 'z'), p.join('.'),
  p.normalize('/a/b/../../c/./d//'), p.normalize('a/../../b'),
  p.dirname('/a/b/c'), p.dirname('/a'), p.dirname('a'), p.dirname('/'),
  p.basename('/a/b/c.txt'), p.basename('/a/b/c.txt', '.txt'), p.basename('/'),
  p.extname('a/b.c.d'), p.extname('.hidden'), p.extname('noext'),
  p.isAbsolute('/x'), p.isAbsolute('x'),
  p.relative('/a/b/c', '/a/d'), p.relative('/a/b', '/a/b'),
  JSON.stringify(p.parse('/home/user/file.txt')),
  p.resolve('/base', 'sub', '../x'),
  u.fileURLToPath('file:///tmp/x%20y.txt'),
  u.pathToFileURL('/tmp/q r').href,
  new u.URL('https://h/p?a=1').searchParams.get('a'),
];
console.log(JSON.stringify(cases));
`;

test('path/url characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-path-'));
  const f = path.join(dir, 'table.cjs');
  fs.writeFileSync(f, TABLE);
  const nodeOut = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const tjsOut = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(tjsOut, nodeOut);
});

test('os module basics under tjs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-'));
  const f = path.join(dir, 'os.cjs');
  fs.writeFileSync(f, `const os = require('node:os');
console.log(JSON.stringify({ home: os.homedir().startsWith('/'), tmp: os.tmpdir().length > 0, plat: os.platform(), eol: os.EOL }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out, { home: true, tmp: true, plat: process.platform, eol: '\n' });
});

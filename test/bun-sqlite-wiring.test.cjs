'use strict';
// Wiring: bun-shim registers bun:sqlite in BUN_BUILTINS (Module._load hook) and
// sets a backend — node:sqlite under the classic Node launcher, or the
// tjs:sqlite class the quaude bootstrap stashed under tjs. Run in a subprocess so
// bun-shim's global side effects (Module._load monkeypatch, globalThis.WebSocket)
// don't leak into the rest of the suite (mirrors node-shim-bunshim.test.cjs).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const shim = path.resolve(__dirname, '../libexec/bun-shim.cjs');
const runNode = (script) =>
  execFileSync(process.execPath, ['-e', script, shim],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }).trim();

test('bun-shim resolves require("bun:sqlite") to a working DB (node:sqlite backend)', () => {
  const out = runNode(`
    require(process.argv[1]);                       // load bun-shim -> registers bun:sqlite + backend
    const { Database } = require('bun:sqlite');      // resolved by bun-shim's Module._load hook
    const db = new Database(':memory:');
    db.exec('CREATE TABLE hist (id INTEGER PRIMARY KEY, entry TEXT)');
    db.query('INSERT INTO hist(entry) VALUES(?)').run('a');
    db.query('INSERT INTO hist(entry) VALUES(?)').run('b');
    process.stdout.write(db.query('SELECT entry FROM hist ORDER BY id').all().map(r => r.entry).join(','));
    db.close();
  `);
  assert.strictEqual(out, 'a,b');
});

test('bun-shim prefers the tjs:sqlite class the bootstrap stashed on the global', () => {
  // Simulate the quaude bootstrap having pre-stashed a tjs:sqlite-shaped class;
  // bun-shim must use IT (not node:sqlite). We stash node:sqlite's DatabaseSync
  // (a valid tjs:sqlite-shaped backend) and mark it so we can prove it was used.
  const out = runNode(`
    const { DatabaseSync } = require('node:sqlite');
    class Marked extends DatabaseSync { constructor(p){ super(p); globalThis.__usedStashed = true; } }
    globalThis.__clodeTjsSqliteDatabase = Marked;
    require(process.argv[1]);
    const { Database } = require('bun:sqlite');
    const db = new Database(':memory:'); db.exec('CREATE TABLE t(x INTEGER)'); db.close();
    process.stdout.write(String(globalThis.__usedStashed === true));
  `);
  assert.strictEqual(out, 'true');
});

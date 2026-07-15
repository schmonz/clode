'use strict';
// bun:sqlite -> node:sqlite, the Bun->Node layer inlined in bun-shim. Run in a
// subprocess (so bun-shim's global side effects don't leak into the suite) and
// backed by NATIVE node:sqlite — real SQLite, not a mock. The node:sqlite->tjs
// layer lives in node-shim/modules/sqlite.cjs and is tested in
// test/node-sqlite-shim.test.cjs.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const shim = path.resolve(__dirname, '../libexec/bun-shim.cjs');
const run = (body) => execFileSync(process.execPath,
  ['-e', `require(${JSON.stringify(shim)}); const { Database } = require('bun:sqlite');\n${body}`],
  { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }).trim();

test('query(sql).all() returns rows (via bun-shim -> node:sqlite)', () => {
  assert.strictEqual(run(`
    const db = new Database(':memory:'); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    db.query('INSERT INTO t(name) VALUES(?)').run('a');
    db.query('INSERT INTO t(name) VALUES(?)').run('b');
    process.stdout.write(db.query('SELECT name FROM t ORDER BY id').all().map(r => r.name).join(','));
  `), 'a,b');
});

test('run() returns { changes, lastInsertRowid }', () => {
  assert.strictEqual(run(`
    const db = new Database(':memory:'); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    const i = db.query('INSERT INTO t(name) VALUES(?)').run('a');
    process.stdout.write(i.changes + ':' + i.lastInsertRowid);
  `), '1:1');
});

test('get() -> first row or undefined; values() -> arrays', () => {
  assert.strictEqual(run(`
    const db = new Database(':memory:'); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    db.query('INSERT INTO t(name) VALUES(?)').run('a');
    const g = db.query('SELECT name FROM t WHERE id=?').get(1);
    const none = db.query('SELECT name FROM t WHERE id=?').get(99);
    const v = db.query('SELECT id, name FROM t').values();
    process.stdout.write([g.name, none === undefined, JSON.stringify(v)].join('|'));
  `), 'a|true|[[1,"a"]]');
});

test('transaction(fn) commits, rolls back on throw', () => {
  assert.strictEqual(run(`
    const db = new Database(':memory:'); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    db.transaction((n) => { for (const x of n) db.query('INSERT INTO t(name) VALUES(?)').run(x); })(['a','b','c']);
    try { db.transaction(() => { db.query('INSERT INTO t(name) VALUES(?)').run('x'); throw new Error('boom'); })(); } catch (_) {}
    process.stdout.write(String(db.query('SELECT COUNT(*) AS c FROM t').get().c));
  `), '3');
});

test('unimplemented methods fail loud (marked)', () => {
  assert.strictEqual(run(`
    const db = new Database(':memory:'); const s = db.query('SELECT 1 AS x');
    let ok = true;
    try { s.iterate(); ok = false; } catch (e) { if (!/not yet implemented/.test(e.message)) ok = false; }
    process.stdout.write(String(ok));
  `), 'true');
});

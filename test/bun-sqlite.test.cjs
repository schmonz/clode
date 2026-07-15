'use strict';
// bun:sqlite shim (libexec/bun-sqlite.cjs) — maps Claude Code's bun:sqlite calls
// onto tjs:sqlite. Backed here by a tjs:sqlite-SHAPED adapter over real
// node:sqlite SQL (not a mock — real SQLite), so the mapping is exercised against
// tjs:sqlite's exact surface as probed 2026-07-15: Database{prepare,exec,close};
// Statement{all(...params), run(...params) -> UNDEFINED, finalize}; NO .get();
// all() -> array of objects. A separate docker probe validates against real
// tjs:sqlite. The shim takes the tjs Database class by injection because
// new Database() is sync while import('tjs:sqlite') is async (bootstrap pre-loads).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

function tjsLikeBackend() {
  return class TjsDatabase {
    constructor(path) { this._d = new DatabaseSync(path); }
    exec(sql) { this._d.exec(sql); }
    close() { this._d.close(); }
    prepare(sql) {
      const st = this._d.prepare(sql);
      return {
        all: (...p) => st.all(...p),
        run: (...p) => { st.run(...p); },   // tjs run() returns nothing
        finalize() {},
      };
    }
  };
}

const bunSqlite = require('../libexec/bun-sqlite.cjs');
bunSqlite.__setBackend(tjsLikeBackend());
const { Database } = bunSqlite;

test('Database.query(sql).all() returns rows as objects', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.query('INSERT INTO t (name) VALUES (?)').run('alice');
  const rows = db.query('SELECT id, name FROM t').all();
  // proto-agnostic: the row-object prototype is the backend's (node:sqlite
  // returns null-proto); the shim's contract is the column data.
  assert.deepStrictEqual(rows.map((r) => ({ ...r })), [{ id: 1, name: 'alice' }]);
  db.close();
});

test('Statement.run() returns { changes, lastInsertRowid } (tjs run() gives nothing)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const info = db.query('INSERT INTO t (name) VALUES (?)').run('alice');
  assert.strictEqual(info.changes, 1);
  assert.strictEqual(Number(info.lastInsertRowid), 1);
  const info2 = db.query('INSERT INTO t (name) VALUES (?)').run('bob');
  assert.strictEqual(Number(info2.lastInsertRowid), 2);
  db.close();
});

test('Statement.get() returns the first row, or undefined when none (tjs has no get)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.query('INSERT INTO t (name) VALUES (?)').run('alice');
  const row = db.query('SELECT name FROM t WHERE id = ?').get(1);
  assert.strictEqual(row.name, 'alice');
  assert.strictEqual(db.query('SELECT name FROM t WHERE id = ?').get(999), undefined);
  db.close();
});

test('Statement.values() returns rows as arrays (column order)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.query('INSERT INTO t (name) VALUES (?)').run('alice');
  db.query('INSERT INTO t (name) VALUES (?)').run('bob');
  const vals = db.query('SELECT id, name FROM t ORDER BY id').values();
  assert.deepStrictEqual(vals, [[1, 'alice'], [2, 'bob']]);
  db.close();
});

test('Database.prepare(sql) returns a reusable Statement', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const ins = db.prepare('INSERT INTO t (name) VALUES (?)');
  ins.run('alice');
  ins.run('bob');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM t').get().c, 2);
  db.close();
});

test('Database.transaction(fn) commits on success, rolls back on throw', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const insertMany = db.transaction((names) => {
    for (const n of names) db.query('INSERT INTO t (name) VALUES (?)').run(n);
    return names.length;
  });
  assert.strictEqual(insertMany(['a', 'b', 'c']), 3);
  assert.strictEqual(db.query('SELECT COUNT(*) AS c FROM t').get().c, 3);
  assert.throws(() => db.transaction(() => {
    db.query('INSERT INTO t (name) VALUES (?)').run('x');
    throw new Error('boom');
  })());
  assert.strictEqual(db.query('SELECT COUNT(*) AS c FROM t').get().c, 3); // rolled back
  db.close();
});

// Characterization: named params flow through the shim's ...params forwarding
// (no special code); locks that behavior. (Passes immediately by design.)
test('named params ($name) forward transparently to the backend', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (name TEXT, n INTEGER)');
  db.query('INSERT INTO t VALUES ($name, $n)').run({ $name: 'alice', $n: 7 });
  assert.strictEqual(db.query('SELECT n FROM t WHERE name = $name').get({ $name: 'alice' }).n, 7);
  db.close();
});

test('unimplemented methods FAIL LOUD (clear error), never silent', () => {
  const db = new Database(':memory:');
  const stmt = db.query('SELECT 1 AS x');
  assert.throws(() => stmt.iterate(), /not yet implemented/);
  assert.throws(() => db.serialize(), /not yet implemented/);
  assert.throws(() => db.loadExtension('x'), /not yet implemented/);
  db.close();
});

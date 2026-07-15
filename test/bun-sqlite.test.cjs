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

'use strict';
// node:sqlite -> tjs:sqlite, the Node->tjs layer (node-shim/modules/sqlite.cjs).
// Under real Node node:sqlite is native and this file is unused; under tjs the
// node-shim resolves node:sqlite here. Inject a tjs:sqlite-SHAPED backend (over
// real node:sqlite SQL) via globalThis.__clodeTjsSqlite and verify the module adds
// exactly what tjs:sqlite lacks vs node:sqlite: Statement.get() and run()'s
// { changes, lastInsertRowid } return (tjs's run() returns nothing).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync: NodeDb } = require('node:sqlite');

// tjs:sqlite surface (probed 2026-07-15): Database{prepare->{all,run(->nothing)},
// exec, close}; NO get. Backed by real node:sqlite SQL.
globalThis.__clodeTjsSqlite = {
  Database: class TjsDatabase {
    constructor(p) { this._d = new NodeDb(p); }
    exec(s) { this._d.exec(s); }
    close() { this._d.close(); }
    prepare(s) {
      const st = this._d.prepare(s);
      return { all: (...p) => st.all(...p), run: (...p) => { st.run(...p); } };
    }
  },
};

const { DatabaseSync } = require('../libexec/node-shim/modules/sqlite.cjs');

test('adds Statement.get() that tjs:sqlite lacks (first row / undefined)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t(name) VALUES(?)').run('a');
  assert.strictEqual(db.prepare('SELECT name FROM t WHERE id=?').get(1).name, 'a');
  assert.strictEqual(db.prepare('SELECT name FROM t WHERE id=?').get(99), undefined);
  db.close();
});

test('synthesizes run() -> { changes, lastInsertRowid } (tjs run() returns nothing)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
  const i = db.prepare('INSERT INTO t(name) VALUES(?)').run('a');
  assert.strictEqual(i.changes, 1);
  assert.strictEqual(Number(i.lastInsertRowid), 1);
  assert.strictEqual(Number(db.prepare('INSERT INTO t(name) VALUES(?)').run('b').lastInsertRowid), 2);
  db.close();
});

test('all() passes through', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t(name) VALUES(?)').run('a');
  assert.strictEqual(db.prepare('SELECT name FROM t').all().map((r) => r.name).join(','), 'a');
  db.close();
});

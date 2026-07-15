'use strict';
// bun:sqlite shim over tjs:sqlite. Claude Code stores history/todos via Bun's
// built-in SQLite (`import { Database } from "bun:sqlite"`); tjs ships the same
// SQLite engine as `tjs:sqlite`, so this maps one onto the other. The tjs
// Database class is INJECTED (__setBackend) rather than imported here, because
// `new Database()` is synchronous while `import('tjs:sqlite')` is async — the
// bootstrap pre-loads tjs:sqlite and sets the backend before the bundle runs.
// Built test-first; see test/bun-sqlite.test.cjs.

let TjsDatabase = null;
function __setBackend(cls) { TjsDatabase = cls; }

class Statement {
  constructor(tjsStmt, tjsDb) { this._s = tjsStmt; this._db = tjsDb; }
  all(...params) { return this._s.all(...params); }
  run(...params) {
    this._s.run(...params);
    // Bun's Statement.run returns { changes, lastInsertRowid }; tjs:sqlite's
    // run() returns nothing, so synthesize from the connection's SQLite state.
    const [info] = this._db
      .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
      .all();
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
}

class Database {
  constructor(path) {
    if (!TjsDatabase) {
      throw new Error('bun:sqlite: tjs:sqlite backend not loaded (bootstrap must pre-import it)');
    }
    this._db = new TjsDatabase(path);
  }
  exec(sql) { this._db.exec(sql); }
  query(sql) { return new Statement(this._db.prepare(sql), this._db); }
  close() { this._db.close(); }
}

module.exports = { Database, default: Database, __setBackend };

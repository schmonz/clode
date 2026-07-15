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

// Fail-loud, MARKED stub for bun:sqlite surface we don't implement yet: throws a
// clear error the day Claude Code reaches for it (never a silent undefined), and
// __bunSqliteStub lets apicheck/coverage report it as provided-but-unimplemented
// — the "how will we find out" seam (same shape as bun-shim's __bunShimStub).
function notYetImplemented(name) {
  const f = function () {
    throw new Error(`bun:sqlite.${name} not yet implemented in the tjs:sqlite shim`);
  };
  f.__bunSqliteStub = true;
  return f;
}

class Statement {
  constructor(tjsStmt, tjsDb) { this._s = tjsStmt; this._db = tjsDb; }
  all(...params) { return this._s.all(...params); }
  // tjs:sqlite has no get(); take the first of all(). Bun returns undefined for
  // no row (better-sqlite3 convention it mirrors).
  get(...params) { const rows = this._s.all(...params); return rows.length ? rows[0] : undefined; }
  // Bun's values() yields rows as arrays; tjs returns objects, whose key order
  // is the SELECT column order.
  values(...params) { return this._s.all(...params).map((r) => Object.values(r)); }
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
  // Bun distinguishes query (cached) from prepare (uncached); we don't cache, so
  // both just wrap a fresh tjs prepared statement.
  prepare(sql) { return new Statement(this._db.prepare(sql), this._db); }
  // Bun's transaction(fn) returns a function that runs fn inside BEGIN/COMMIT,
  // rolling back on throw and re-raising. (deferred/immediate/exclusive variants
  // + SAVEPOINT nesting are not yet needed — a fail-loud stub can guard them.)
  transaction(fn) {
    const db = this;
    return function (...args) {
      db.exec('BEGIN');
      try {
        const r = fn.apply(this, args);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
  }
  close() { this._db.close(); }
}

// bun:sqlite surface Claude Code isn't known to use — fail loud + marked, so a
// future call is a diagnosable error + an apicheck work-list entry, not a
// silent gap. Implement (TDD) if apicheck ever flags one as used.
Statement.prototype.iterate = notYetImplemented('Statement.iterate');
Statement.prototype.as = notYetImplemented('Statement.as');
Database.prototype.serialize = notYetImplemented('Database.serialize');
Database.prototype.loadExtension = notYetImplemented('Database.loadExtension');

module.exports = { Database, default: Database, __setBackend };

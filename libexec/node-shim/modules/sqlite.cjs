'use strict';
// node:sqlite backed by tjs:sqlite — the Node->tjs layer. Under real Node,
// node:sqlite is native and this file is never used; under tjs the node-shim
// resolves require('node:sqlite') here. bun-shim's Bun->Node layer targets
// node:sqlite (rich: get/run-return native), so the *only* adaptation is the
// two things tjs:sqlite lacks vs node:sqlite:
//   - Statement.get()  (tjs has no get)          -> all(...)[0]
//   - Statement.run() returns {changes,lastInsertRowid} (tjs run() returns
//     nothing)                                    -> synthesize via changes()/
//                                                    last_insert_rowid()
// Validated against real tjs:sqlite 2026-07-15. tjs:sqlite is async to import
// but node's DatabaseSync is synchronous, so it's read from a pre-stashed global
// (the quaude bootstrap awaits import('tjs:sqlite') before booting the cli); a
// lazy fire-and-forget import is the fallback (the first DB open is post-startup,
// after it resolves). Tests set globalThis.__clodeTjsSqlite directly.

let tjsSqlite = globalThis.__clodeTjsSqlite || null;
if (!tjsSqlite && typeof globalThis.tjs !== 'undefined') {
  import('tjs:sqlite').then((m) => { tjsSqlite = m; }).catch(() => {});
}

function backend() {
  const b = tjsSqlite || globalThis.__clodeTjsSqlite;
  if (!b || !b.Database) {
    throw new Error('node:sqlite: no tjs:sqlite backend available in this runtime');
  }
  return b.Database;
}

class StatementSync {
  constructor(tjsStmt, db) { this._s = tjsStmt; this._db = db; }
  all(...params) { return this._s.all(...params); }
  get(...params) { const rows = this._s.all(...params); return rows.length ? rows[0] : undefined; }
  run(...params) {
    this._s.run(...params);
    const [info] = this._db
      .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
      .all();
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
}

class DatabaseSync {
  constructor(path) { this._db = new (backend())(path); }
  prepare(sql) { return new StatementSync(this._db.prepare(sql), this._db); }
  exec(sql) { this._db.exec(sql); }
  close() { this._db.close(); }
}

module.exports = { DatabaseSync, StatementSync };

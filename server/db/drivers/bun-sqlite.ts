// Bun-SQLite driver — wraps the synchronous `bun:sqlite` `Database` in
// an async `DbDriver` so the repos can use the same shape on both the
// Bun host and the Workers host (D1). The wrappers in `database.ts`
// (queryAll / queryFirst / run / batch / withTx) gain their async
// signatures here; the existing repos that take a `Database` argument
// continue to compile until Phase 6 wires the HTTP layer through
// `createApiHandler({ driver, env, ... })`.
//
// On the Bun host this driver is a thin shim — every method's promise
// resolves on the next microtask, so behavior is byte-identical to the
// synchronous `Database` it wraps.

import type { Database, Statement } from "bun:sqlite";
import type { DbDriver, DbStmt, LexaRow, SqlParam, StmtResult } from "../driver";

class BunSqliteStmt implements DbStmt {
  constructor(private readonly stmt: Statement) {}
  all<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T[]> {
    return Promise.resolve(this.stmt.all(...params) as T[]);
  }
  first<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T | null> {
    return Promise.resolve((this.stmt.get(...params) ?? null) as T | null);
  }
  run(...params: SqlParam[]): Promise<StmtResult> {
    const r = this.stmt.run(...params);
    return Promise.resolve({ changes: r.changes, lastInsertRowid: r.lastInsertRowid });
  }
}

export function createBunSqliteDriver(db: Database): DbDriver {
  let txDepth = 0;

  const driver: DbDriver = {
    prepare(sql: string): DbStmt {
      return new BunSqliteStmt(db.prepare(sql));
    },
    async batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<void> {
      if (txDepth > 0) {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
        return;
      }
      db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();
    },
    async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
      if (txDepth > 0) return fn(driver);
      txDepth++;
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (e) {
        txDepth--;
        throw e;
      }
      try {
        const result = await fn(driver);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      } finally {
        txDepth--;
      }
    },
    close(): void {
      db.close();
    },
  };

  return driver;
}

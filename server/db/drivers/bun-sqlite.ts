// Bun-SQLite driver — wraps the synchronous `bun:sqlite` `Database` in
// an async `DbDriver` so the repos can use the same shape on both the
// Bun host and the Workers host (D1). The wrappers in `db.ts`
// (queryAll / queryFirst / run / batch / batchResults / withTx) gain
// their async signatures here; the repos and the HTTP layer consume the
// driver through `createApiHandler({ driver, env, ... })`.
//
// On the Bun host this driver is a thin shim — every method's promise
// resolves on the next microtask, so behavior is byte-identical to the
// synchronous `Database` it wraps.

import type { Database, Statement } from "bun:sqlite";
import type { BatchStmtResult, DbDriver, DbStmt, LexaRow, SqlParam, StmtResult } from "../driver";

class BunSqliteStmt implements DbStmt {
  constructor(private readonly stmt: Statement) {}
  get columnNames(): string[] {
    return this.stmt.columnNames;
  }
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

/** Synthesize the D1-shaped positional batch result from a Bun transaction.
 *  A row-returning statement (`columnNames` non-empty, i.e. SELECT or
 *  `...RETURNING`) is executed with `all()` so its rows are captured;
 *  everything else with `run()`. Divergence from D1: for a row-returning
 *  statement `changes = rows.length` (D1 reports 0 for a SELECT) — no
 *  consumer reads `changes` from a SELECT. */
function collectBatch(db: Database, stmts: { sql: string; params: SqlParam[] }[]): BatchStmtResult[] {
  const out: BatchStmtResult[] = [];
  for (const s of stmts) {
    const stmt = db.prepare(s.sql);
    if (stmt.columnNames.length > 0) {
      const rows = stmt.all(...s.params) as LexaRow[];
      out.push({ results: rows, changes: rows.length });
    } else {
      const r = stmt.run(...s.params);
      out.push({ results: [], changes: r.changes, lastInsertRowid: r.lastInsertRowid });
    }
  }
  return out;
}

export function createBunSqliteDriver(db: Database): DbDriver {
  // Connection-level settings for every Bun-host connection this driver
  // wraps. The prod API connection (buildBunApp, server/api/http.ts) already
  // sets WAL/foreign_keys/busy_timeout itself; the true delta here is
  // synchronous=NORMAL (set nowhere else) plus the boot helpers
  // (github-config-boot.ts, provider-secrets-boot.ts) that open a bare
  // `new Database` and now gain all four. Follow-up: once this driver owns
  // them, the hand-rolled PRAGMAs in http.ts and app/lib/share.server.ts are
  // redundant.
  //
  // `PRAGMA journal_mode = WAL` does NOT throw when WAL cannot be enabled —
  // it silently keeps the prior mode. WAL is unavailable for :memory:
  // (reads back "memory"), so only a read-back of "wal" or "memory" passes;
  // any other mode (e.g. "delete" on a filesystem without shared-memory
  // support) throws at boot rather than degrading silently.
  const journal = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null;
  if (journal && journal.journal_mode !== "wal" && journal.journal_mode !== "memory") {
    throw new Error(`SQLite refused WAL journal mode (got "${journal.journal_mode}")`);
  }
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  let txDepth = 0;

  const driver: DbDriver = {
    supportsInteractiveTx: true,
    prepare(sql: string): DbStmt {
      return new BunSqliteStmt(db.prepare(sql));
    },
    async batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<BatchStmtResult[]> {
      if (txDepth > 0) return collectBatch(db, stmts);
      return db.transaction(() => collectBatch(db, stmts))();
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

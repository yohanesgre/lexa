// Test-only shim: vitest workers run under node, which cannot resolve
// bun:sqlite (and node's bundled SQLite lacks FTS5, which migrations need).
// vitest.config.ts aliases bun:sqlite to this file; it re-implements the small
// bun:sqlite surface used by server/db over better-sqlite3. Never imported in
// production (the server runs under bun, where bun:sqlite is native).
import BetterDatabase from "better-sqlite3";

type NativeDb = BetterDatabase.Database;
type NativeStmt = BetterDatabase.Statement;

class Statement {
  constructor(private stmt: NativeStmt) {}

  get(...params: unknown[]): unknown {
    // bun:sqlite returns null for a missing row; better-sqlite3 returns undefined.
    const row = this.stmt.get(...params);
    return row === undefined ? null : row;
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt.run(...params);
  }
}

export class Database {
  private db: NativeDb;

  constructor(path: string) {
    // Low busy_timeout default so tests can observe initSqlite's pragma.
    this.db = new BetterDatabase(path, { timeout: 100 });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  // bun:sqlite's Database.query() — a prepared-statement-like handle.
  query(sql: string): Statement {
    return this.prepare(sql);
  }

  // bun:sqlite's Database.run() executes every statement; better-sqlite3 can
  // only prepare one statement per call, so no-param calls go through exec.
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    if (params.length === 0) {
      this.db.exec(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }
    return this.db.prepare(sql).run(...params);
  }

  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

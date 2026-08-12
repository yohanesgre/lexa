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

  // bun:sqlite exposes the result column names — better-auth's bun:sqlite
  // dialect checks it to decide read-vs-write statements. better-sqlite3
  // throws columns() on non-returning statements, so gate on .reader.
  get columnNames(): string[] {
    if (!this.stmt.reader) return [];
    return this.stmt.columns().map((c) => c.name);
  }

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
  private native: NativeDb;

  constructor(path: string) {
    // Low busy_timeout default so tests can observe initSqlite's pragma.
    // NOTE: the backing field must NOT be named `db` — better-auth's kysely
    // adapter detects "db" in db as "already a Kysely instance" and would
    // grab the raw better-sqlite3 handle (no selectFrom → TypeError).
    this.native = new BetterDatabase(path, { timeout: 100 });
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.native.prepare(sql));
  }

  // bun:sqlite's Database.query() — a prepared-statement-like handle.
  query(sql: string): Statement {
    return this.prepare(sql);
  }

  // bun:sqlite's Database.run() executes every statement; better-sqlite3 can
  // only prepare one statement per call, so no-param calls go through exec.
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    if (params.length === 0) {
      this.native.exec(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }
    return this.native.prepare(sql).run(...params);
  }

  // bun:sqlite detection key for better-auth's kysely adapter (it checks
  // `"fileControl" in db` to pick the bun:sqlite dialect).
  fileControl(): void {}

  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    return this.native.transaction(fn);
  }

  close(): void {
    this.native.close();
  }
}

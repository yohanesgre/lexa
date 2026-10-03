type SqlParam = string | number | bigint | boolean | null | Uint8Array | Date;

declare module "bun:sqlite" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    all(...params: SqlParam[]): unknown[];
    all(...params: unknown[]): unknown[];
    get(...params: SqlParam[]): unknown | null;
    get(...params: unknown[]): unknown | null;
    run(...params: SqlParam[]): RunResult;
    run(...params: unknown[]): RunResult;
  }

  class Database {
    constructor(path: string);
    prepare(sql: string): Statement;
    query(sql: string): Statement;
    run(sql: string, ...params: SqlParam[]): RunResult;
    run(sql: string, ...params: unknown[]): RunResult;
    exec(sql: string): void;
    transaction<T>(fn: (...args: SqlParam[]) => T): (...args: SqlParam[]) => T;
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
    close(): void;
  }
}

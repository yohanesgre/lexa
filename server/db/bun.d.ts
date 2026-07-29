declare module "bun:sqlite" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  interface Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): RunResult;
  }

  class Database {
    constructor(path: string);
    prepare(sql: string): Statement;
    transaction(fn: (...args: any[]) => void): (...args: any[]) => void;
    close(): void;
    exec(sql: string): void;
  }
}

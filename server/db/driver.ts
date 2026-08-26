// Async DB driver interface — the abstraction the repos use. Two
// implementations: `bun-sqlite.ts` (wraps the sync `bun:sqlite` API in
// `Promise.resolve`, byte-identical behavior) and `d1.ts` (wraps a
// `D1Database` binding for Cloudflare Workers). The D1 driver does NOT
// implement `transaction()` — D1 has no BEGIN/COMMIT, so atomic multi-
// statement sites use `db.batch()` arrays of `{ sql, params }` instead
// (see Phase 5 for the invariant re-expression).
//
// The two drivers also produce a different `lastInsertRowid` shape. Bun
// surfaces a stable `lastInsertRowid` on every run; D1 does not surface
// it reliably. Callers that need a row id use a `RETURNING` clause on D1
// (handled per repo) or a follow-up read.

import { Data } from "effect";

/** One row from a query — column names → column values. The driver
 *  implementation decides the JS types (Bun: native, D1: per the binding's
 *  cast in `d1.ts`). */
export type LexaRow = Record<string, unknown>;

/** One parameter to a prepared statement. D1's binding accepts the same
 *  primitive set as SQLite. */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array | Date;

export interface StmtResult {
  changes: number;
  /** Bun path: reliable. D1 path: undefined — callers must use RETURNING. */
  lastInsertRowid?: number | bigint;
}

export interface DbStmt {
  all<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T[]>;
  first<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T | null>;
  run(...params: SqlParam[]): Promise<StmtResult>;
}

export interface DbDriver {
  prepare(sql: string): DbStmt;
  /** Atomic batch — bun-sqlite wraps `db.transaction`, D1 calls the binding's
   *  `batch()` method. Failures roll back the whole array. */
  batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<void>;
  /** Interactive transaction — bun-sqlite only. D1 throws (use `batch` instead). */
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
  close(): void;
}

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{ message: string; isPositionConflict: boolean }> {}
export class BatchTimeout extends Data.TaggedError("BatchTimeout")<{ message: string }> {}

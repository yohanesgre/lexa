// Async DB driver interface — the abstraction the repos use. Two
// implementations: `bun-sqlite.ts` (wraps the sync `bun:sqlite` API in
// `Promise.resolve`, byte-identical behavior) and `d1.ts` (wraps a
// `D1Database` binding for Cloudflare Workers). The D1 driver does NOT
// implement `transaction()` — D1 has no BEGIN/COMMIT — so atomic multi-
// statement sites use `db.batch()` arrays of `{ sql, params }` on BOTH
// drivers: `batch()`/`batchResults()` in `db.ts` are the atomic path, and
// converted sites no longer use `withTx`. Repos expose their write SQL
// through pure builders (`server/repos/*-batch.ts`) — the single source of
// truth both drivers consume. The remaining read-dependent `withTx` sites
// are tracked for a follow-up.
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

export interface BatchStmtResult {
  /** Rows produced by the statement (SELECT or ...RETURNING); [] otherwise. */
  results: LexaRow[];
  /** Rows changed by the statement (D1: meta.changes; Bun: synthesized).
   *  Divergence: on Bun a row-returning statement reports `rows.length`,
   *  while D1 reports 0 for a SELECT — no consumer reads `changes` from a
   *  SELECT. */
  changes: number;
  /** Bun path only (from run()); D1 leaves undefined — use RETURNING. */
  lastInsertRowid?: number | bigint;
}

export interface DbStmt {
  all<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T[]>;
  first<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T | null>;
  run(...params: SqlParam[]): Promise<StmtResult>;
  /** Bun only: result column names (empty = no row output). Used by the
   *  nested-batch synthesis in db.ts; D1 omits it. */
  readonly columnNames?: string[];
}

export interface DbDriver {
  prepare(sql: string): DbStmt;
  /** Atomic batch — bun-sqlite wraps `db.transaction`, D1 calls the binding's
   *  `batch()`. Failures roll back the whole array. Positional results. */
  batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<BatchStmtResult[]>;
  /** Interactive transaction — bun-sqlite only. D1 throws (use `batch` instead). */
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
  /** Capability flag for the async `withTx` helper (`server/db/db.ts`).
   *  `false` on D1 (no BEGIN/COMMIT — callers run sequentially, each
   *  `batch()` still atomic); `true`/undefined everywhere else. */
  supportsInteractiveTx?: boolean;
  close(): void;
}

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{ message: string; isPositionConflict: boolean }> {}
/** Raised when the D1 binding returned a batch over its time budget. It is
 *  thrown AFTER the binding returned, so the batch MAY HAVE COMMITTED;
 *  `postCommit: true` is the typed marker of that ambiguity — callers must
 *  not blindly retry. Only `ConstraintViolation.isPositionConflict` is
 *  retryable (the abort precedes commit). Bun never raises this. */
export class BatchTimeout extends Data.TaggedError("BatchTimeout")<{ message: string; postCommit: true }> {}

/** Map a raw driver/SQLite throw to a typed driver error. Lives here (not in
 *  `db.ts`) so the drivers can use it without importing the Effect layer —
 *  `db.ts` re-exports it for the existing import paths. */
export function mapDbError(e: unknown): ConstraintViolation | DbError {
  const msg = String(e);
  if (e instanceof ConstraintViolation || e instanceof DbError) return e;
  if (msg.includes("SQLITE_CONSTRAINT") || /constraint failed/i.test(msg)) {
    return new ConstraintViolation({
      message: msg,
      isPositionConflict: /tasks\.column_id.*tasks\.position/.test(msg),
    });
  }
  return new DbError({ message: msg, cause: e });
}

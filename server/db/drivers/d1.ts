// D1 driver — wraps a `D1Database` binding for the Cloudflare Workers
// flavor. The D1 binding's API is async, so this driver is natively
// Promise-based. The interface matches the bun-sqlite driver's.
//
// Differences from bun-sqlite:
//   * No interactive transaction — D1 has no BEGIN/COMMIT. The
//     `transaction()` method throws; atomicity is expressed as
//     pre-computed `db.batch()` arrays, the same `batch()`/
//     `batchResults()` path both drivers use.
//   * `lastInsertRowid` is not reliable on D1 — the D1 binding's `run()`
//     returns the meta-changes count but does not surface the rowid.
//     Callers that need the rowid use a `RETURNING` clause on the
//     INSERT and read the first column via `first()`. The `run()` result
//     has `lastInsertRowid` as `undefined`.
//   * `batch()` calls the binding's `batch()` directly, with a 30s
//     budget. Error semantics (all post-commit on the binding's side):
//       - any statement error aborts/rolls back the whole batch; the throw
//         is mapped by `mapDbError` (ConstraintViolation, incl.
//         `isPositionConflict`, else DbError);
//       - a returned `success=false` item → DbError (defensive — real D1
//         throws instead);
//       - summed `meta.duration > 28_000` → BatchTimeout, raised AFTER the
//         batch returned and carrying `postCommit: true`. This means the
//         batch MAY HAVE COMMITTED — do not blindly retry. Only
//         `ConstraintViolation.isPositionConflict` is retryable (the abort
//         precedes commit). No behavior change here.
//     Bun: `db.transaction` wraps the whole array; throw → rollback; mapped
//     the same. No BatchTimeout on Bun.
//
// The driver takes a `D1Database` typed via `unknown` so this file
// compiles without pulling in `@cloudflare/workers-types` at the type
// level — the entry on Workers narrows `env.DB` to `D1Database` and
// hands the instance to this factory.

import type { BatchStmtResult, DbDriver, DbStmt, LexaRow, SqlParam, StmtResult } from "../driver";
import { BatchTimeout, ConstraintViolation, DbError, RowNotFound, mapDbError } from "../driver";

/** D1 binding surface — the subset the driver calls. Matches
 *  `@cloudflare/workers-types` `D1Database` + `D1PreparedStatement`. */
export interface D1Like {
  prepare(query: string): D1PreparedLike;
  batch(statements: D1BatchItem[]): Promise<D1BatchItemResult[]>;
}

export interface D1PreparedLike {
  bind(...params: unknown[]): D1PreparedLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: unknown }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes: number; duration?: number; last_row_id?: number } }>;
}

export interface D1BatchItem {
  sql: string;
  params?: unknown[];
}

export interface D1BatchItemResult {
  success: boolean;
  results?: unknown[];
  meta?: { changes?: number; duration?: number; last_row_id?: number };
}

class D1Stmt implements DbStmt {
  constructor(private readonly stmt: D1PreparedLike) {}
  all<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T[]> {
    return Promise.resolve(
      this.stmt.bind(...params).all<T>().then((r) => r.results),
    );
  }
  first<T extends LexaRow = LexaRow>(...params: SqlParam[]): Promise<T | null> {
    return Promise.resolve(this.stmt.bind(...params).first<T>());
  }
  run(...params: SqlParam[]): Promise<StmtResult> {
    return Promise.resolve(
      this.stmt.bind(...params).run().then((r) => ({ changes: r.meta.changes })),
    );
  }
}

export function createD1Driver(d1: D1Like): DbDriver {
  return {
    supportsInteractiveTx: false,
    prepare(sql: string): DbStmt {
      return new D1Stmt(d1.prepare(sql));
    },
    async batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<BatchStmtResult[]> {
      let items: D1BatchItemResult[];
      try {
        items = await d1.batch(stmts.map((s) => ({ sql: s.sql, params: s.params })));
      } catch (e) {
        throw mapDbError(e);
      }
      // D1's batch enforces a 30s wall-clock ceiling per call. Surface a
      // typed `BatchTimeout` if the summed meta duration approaches the cap.
      // Post-commit ambiguity: this throw happens after the binding returned,
      // so the batch MAY HAVE COMMITTED — callers must not blindly retry.
      const duration = items.reduce((sum, r) => sum + (r.meta?.duration ?? 0), 0);
      if (duration > 28_000) {
        throw new BatchTimeout({ message: `D1 batch exceeded 28s budget (${duration}ms)`, postCommit: true });
      }
      for (const r of items) {
        if (!r.success) throw new DbError({ message: "D1 batch returned success=false" });
      }
      return items.map((r): BatchStmtResult => ({
        results: (r.results ?? []) as LexaRow[],
        changes: r.meta?.changes ?? 0,
        ...(r.meta?.last_row_id !== undefined ? { lastInsertRowid: r.meta.last_row_id } : {}),
      }));
    },
    async transaction<T>(): Promise<T> {
      // D1 has no BEGIN/COMMIT. Atomicity is expressed via `batch()` —
      // the same `batch()`/`batchResults()` path both drivers use;
      // converted sites no longer use `withTx`. The remaining
      // read-dependent `withTx` sites are tracked for a follow-up.
      throw new DbError({
        message: "D1 has no interactive transactions; use db.batch([{sql, params}, ...]) for atomicity",
      });
    },
    close(): void {
      // D1 binding has no close; the isolate owns the lifecycle.
    },
  };
}

// Re-export the error classes so callers can `import { ConstraintViolation,
// RowNotFound, DbError } from "../driver"` and reach the same names
// regardless of which driver is in use.
export { ConstraintViolation, DbError, RowNotFound };

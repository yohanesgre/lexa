// D1 driver — wraps a `D1Database` binding for the Cloudflare Workers
// flavor. The D1 binding's API is async, so this driver is natively
// Promise-based. The interface matches the bun-sqlite driver's.
//
// Differences from bun-sqlite:
//   * No interactive transaction — D1 has no BEGIN/COMMIT. The
//     `transaction()` method throws; the atomicity invariants are
//     re-expressed as pre-computed `db.batch()` arrays (see Phase 5).
//   * `lastInsertRowid` is not reliable on D1 — the D1 binding's `run()`
//     returns the meta-changes count but does not surface the rowid.
//     Callers that need the rowid use a `RETURNING` clause on the
//     INSERT and read the first column via `first()`. The `run()` result
//     has `lastInsertRowid` as `undefined`.
//   * `batch()` calls the binding's `batch()` directly, with a 30s
//     budget (D1 raises a `BatchTimeout` if `meta?.duration > 28_000`).
//
// The driver takes a `D1Database` typed via `unknown` so this file
// compiles without pulling in `@cloudflare/workers-types` at the type
// level — the entry on Workers narrows `env.DB` to `D1Database` and
// hands the instance to this factory.

import type { DbDriver, DbStmt, LexaRow, SqlParam, StmtResult } from "../driver";
import { BatchTimeout, ConstraintViolation, DbError, RowNotFound } from "../driver";

/** D1 binding surface — the subset the driver calls. Matches
 *  `@cloudflare/workers-types` `D1Database` + `D1PreparedStatement`. */
export interface D1Like {
  prepare(query: string): D1PreparedLike;
  batch<T = unknown>(statements: D1BatchItem[]): Promise<D1BatchResult<T>>;
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

export interface D1BatchResult<T> {
  length: number;
  duration: number;
  results: T[];
  success: boolean;
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
    prepare(sql: string): DbStmt {
      return new D1Stmt(d1.prepare(sql));
    },
    async batch(stmts: { sql: string; params: SqlParam[] }[]): Promise<void> {
      const result = await d1.batch(
        stmts.map((s) => ({ sql: s.sql, params: s.params })),
      );
      // D1's batch enforces a 30s wall-clock ceiling per call. Surface
      // a typed `BatchTimeout` if the meta duration approaches the cap.
      if (result.duration > 28_000) {
        throw new BatchTimeout({ message: `D1 batch exceeded 28s budget (${result.duration}ms)` });
      }
      if (!result.success) {
        throw new DbError({ message: "D1 batch returned success=false" });
      }
    },
    async transaction<T>(): Promise<T> {
      // D1 has no BEGIN/COMMIT. Atomicity is expressed via `batch()`
      // (pre-computed `{ sql, params }[]` arrays). See Phase 5 for the
      // sites that move from `withTx { repo.x(); repo.y(); }` to
      // `repo.updateAndEmit(diff)` returning a batch array.
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

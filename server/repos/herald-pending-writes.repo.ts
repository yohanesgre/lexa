import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, ConstraintViolation } from "../db/database";

export type PendingWriteStatus = "pending" | "approved" | "rejected" | "expired";

export interface HeraldPendingWriteRow {
  id: string;
  project_id: string;
  document_type: "task" | "wiki" | "chat";
  document_id: string;
  owner_user_id: string;
  batch_id: string;
  seq: number;
  tool_name: string;
  args: string;
  diff: string;
  status: PendingWriteStatus;
  execution_error: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export class HeraldPendingWritesRepo extends Effect.Service<HeraldPendingWritesRepo>()("Lexa/HeraldPendingWritesRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    // Insert input omits the DB-managed columns (status defaults to 'pending',
    // created_at/decided_at are set by SQL, execution_error starts NULL).
    const insert = (
      row: Omit<HeraldPendingWriteRow, "status" | "execution_error" | "created_at" | "decided_at">
    ): Effect.Effect<void, DbError | ConstraintViolation> =>
      Effect.asVoid(
        run(
          db,
          `INSERT INTO herald_pending_writes
             (id, project_id, document_type, document_id, owner_user_id, batch_id, seq,
              tool_name, args, diff, status, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          row.id, row.project_id, row.document_type, row.document_id, row.owner_user_id,
          row.batch_id, row.seq, row.tool_name, row.args, row.diff, row.expires_at
        )
      );

    const sweepExpiredInternal = (): Effect.Effect<number, DbError | ConstraintViolation> =>
      run(db, `UPDATE herald_pending_writes SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')`).pipe(Effect.catchAll(() => Effect.succeed(0 as number)));

    const getById = (id: string): Effect.Effect<HeraldPendingWriteRow | null, DbError> =>
      sweepExpiredInternal().pipe(
        Effect.flatMap(() => queryFirst<HeraldPendingWriteRow>(db, `SELECT * FROM herald_pending_writes WHERE id = ?`, id).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)))),
        Effect.catchAll(() => queryFirst<HeraldPendingWriteRow>(db, `SELECT * FROM herald_pending_writes WHERE id = ?`, id).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null))))
      );

    // Conditional decide — only a 'pending' row moves. Returns the updated
    // row, or null when the row was already decided/expired (guard, not error).
    const decide = (id: string, status: "approved" | "rejected"): Effect.Effect<HeraldPendingWriteRow | null, DbError | ConstraintViolation> =>
      queryFirst<HeraldPendingWriteRow>(
        db,
        `UPDATE herald_pending_writes SET status = ?, decided_at = datetime('now')
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
        status,
        id
      ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));

    // Lazy TTL flip for one row. Returns the expired row, or null when the
    // row was not pending or not yet due.
    const expireIfDue = (id: string): Effect.Effect<HeraldPendingWriteRow | null, DbError> =>
      queryFirst<HeraldPendingWriteRow>(
        db,
        `UPDATE herald_pending_writes SET status = 'expired'
         WHERE id = ? AND status = 'pending' AND expires_at <= datetime('now')
         RETURNING *`,
        id
      ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));

    // Bulk lazy sweep — runs at resume/decide/transcript read time.
    const sweepExpired = (): Effect.Effect<number, DbError | ConstraintViolation> =>
      run(db, `UPDATE herald_pending_writes SET status = 'expired'
               WHERE status = 'pending' AND expires_at <= datetime('now')`);

    const listByBatch = (batchId: string): Effect.Effect<HeraldPendingWriteRow[], DbError> =>
      sweepExpiredInternal().pipe(
        Effect.flatMap(() =>
          queryAll<HeraldPendingWriteRow>(db, `SELECT * FROM herald_pending_writes WHERE batch_id = ? ORDER BY seq ASC`, batchId)
        ),
        Effect.catchAll(() => queryAll<HeraldPendingWriteRow>(db, `SELECT * FROM herald_pending_writes WHERE batch_id = ? ORDER BY seq ASC`, batchId))
      );

    const countByBatchRemaining = (batchId: string): Effect.Effect<number, DbError> =>
      sweepExpiredInternal().pipe(
        Effect.flatMap(() =>
          queryFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM herald_pending_writes WHERE batch_id = ? AND status = 'pending'`, batchId).pipe(
            Effect.map((r) => r.n),
            Effect.catchTag("RowNotFound", () => Effect.succeed(0))
          )
        ),
        Effect.catchAll(() =>
          queryFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM herald_pending_writes WHERE batch_id = ? AND status = 'pending'`, batchId).pipe(
            Effect.map((r) => r.n),
            Effect.catchTag("RowNotFound", () => Effect.succeed(0))
          )
        )
      );

    const markExecutionError = (id: string, error: string): Effect.Effect<void, DbError | ConstraintViolation> =>
      Effect.asVoid(run(db, `UPDATE herald_pending_writes SET execution_error = ? WHERE id = ?`, error, id));

    return { insert, getById, decide, expireIfDue, sweepExpired, listByBatch, countByBatchRemaining, markExecutionError };
  }),
}) {}

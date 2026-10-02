import { Effect } from "effect";
import { Db, queryAll, queryFirst, runReturning, type BatchStmt, type SqlParam, DbError, ConstraintViolation } from "../db/db";
import { ActivityRow, rowToActivityEvent } from "../../shared/db";
import type { ActivityEvent, ActivityType, ActorKind } from "../../shared/types";

export interface ActivityInsertInput {
  taskId: string; actorKind: ActorKind; actorLabel: string;
  actorUserId: string | null; type: ActivityType; message: string;
  viaAssistant?: boolean;
}

const ACTIVITY_INSERT_SQL = `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id, task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant, created_at`;

const activityInsertParams = (input: ActivityInsertInput): SqlParam[] => [
  input.taskId, input.actorKind, input.actorLabel, input.actorUserId,
  input.type, input.message, input.viaAssistant === true ? 1 : 0,
];

export class ActivityRepo extends Effect.Service<ActivityRepo>()("Lexa/ActivityRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    /** Write-only builder for `batch()`/`batchResults()` — RETURNING kept so
     *  the caller can read the inserted row back from the positional results. */
    const insertStmt = (input: ActivityInsertInput): BatchStmt => ({
      sql: ACTIVITY_INSERT_SQL,
      params: activityInsertParams(input),
    });

    const insert = (input: ActivityInsertInput): Effect.Effect<ActivityEvent, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = yield* runReturning<ActivityRow>(
          db,
          ACTIVITY_INSERT_SQL,
          ...activityInsertParams(input)
        ).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "activity row vanished after insert" })))
        );
        return rowToActivityEvent(row);
      });

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<ActivityEvent[], DbError> =>
      queryAll<ActivityRow>(
        db,
        `SELECT id, task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant, created_at
         FROM task_activity
         WHERE task_id = ?
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.id ?? null, limit
      ).pipe(Effect.map((rows) => rows.map(rowToActivityEvent)));

    return { insert, insertStmt, listByTaskKeyset };
  }),
}) {}

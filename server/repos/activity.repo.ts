import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, ConstraintViolation } from "../db/database";
import { ActivityRow, rowToActivityEvent } from "../../shared/db";
import type { ActivityEvent, ActivityType, ActorKind } from "../../shared/types";

export class ActivityRepo extends Effect.Service<ActivityRepo>()("Lexa/ActivityRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const insert = (input: {
      taskId: string; actorKind: ActorKind; actorLabel: string;
      actorUserId: string | null; type: ActivityType; message: string;
    }): Effect.Effect<ActivityEvent, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        yield* run(
          db,
          `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.taskId, input.actorKind, input.actorLabel, input.actorUserId,
          input.type, input.message
        );
        const row = yield* queryFirst<ActivityRow>(
          db,
          `SELECT id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at
           FROM task_activity WHERE id = last_insert_rowid()`
        ).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "activity row vanished after insert" })))
        );
        return rowToActivityEvent(row);
      });

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<ActivityEvent[], DbError> =>
      queryAll<ActivityRow>(
        db,
        `SELECT id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at
         FROM task_activity
         WHERE task_id = ?
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.id ?? null, limit
      ).pipe(Effect.map((rows) => rows.map(rowToActivityEvent)));

    return { insert, listByTaskKeyset };
  }),
}) {}

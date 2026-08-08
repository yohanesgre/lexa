import { Effect } from "effect";
import { Sqlite, DbError, ConstraintViolation } from "../db/database";
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
        const stmt = db.prepare(
          `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at`
        );
        const row = stmt.get(
          input.taskId, input.actorKind, input.actorLabel, input.actorUserId,
          input.type, input.message
        ) as ActivityRow;
        return rowToActivityEvent(row);
      });

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<ActivityEvent[], DbError> =>
      Effect.gen(function* () {
        const stmt = db.prepare(
          `SELECT id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at
           FROM task_activity
           WHERE task_id = ?
             AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        );
        const rows = stmt.all(
          taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
          cursor?.createdAt ?? null, cursor?.id ?? null, limit
        ) as ActivityRow[];
        return rows.map(rowToActivityEvent);
      });

    return { insert, listByTaskKeyset };
  }),
}) {}

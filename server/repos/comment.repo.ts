import { Effect } from "effect";
import { Sqlite, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { CommentRow, rowToComment } from "../../shared/db";
import type { TaskComment, ActorKind } from "../../shared/types";

export class CommentRepo extends Effect.Service<CommentRepo>()("Lexa/CommentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const insert = (input: { taskId: string; authorId: string | null; authorKind: ActorKind; authorLabel: string; body: string }): Effect.Effect<TaskComment, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body)
           VALUES (?, ?, ?, ?, ?) RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(input.taskId, input.authorId, input.authorKind, input.authorLabel, input.body) as CommentRow;
        return rowToComment(row);
      });

    const findById = (id: number): Effect.Effect<TaskComment | null, DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `SELECT id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at
           FROM task_comments WHERE id = ?`
        ).get(id) as CommentRow | undefined;
        return row ? rowToComment(row) : null;
      });

    const updateBody = (id: number, body: string): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `UPDATE task_comments SET body = ?, edited_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
           RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(body, id) as CommentRow | undefined;
        if (!row) return yield* new RowNotFound({ table: "task_comments" });
        return rowToComment(row);
      });

    const softDelete = (id: number): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `UPDATE task_comments SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
           RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(id) as CommentRow | undefined;
        if (!row) return yield* new RowNotFound({ table: "task_comments" });
        return rowToComment(row);
      });

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<TaskComment[], DbError> =>
      Effect.gen(function* () {
        const rows = db.prepare(
          `SELECT id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at
           FROM task_comments
           WHERE task_id = ? AND deleted_at IS NULL
             AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        ).all(taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit) as CommentRow[];
        return rows.map(rowToComment);
      });

    return { insert, findById, updateBody, softDelete, listByTaskKeyset };
  }),
}) {}

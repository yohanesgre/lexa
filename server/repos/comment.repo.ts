import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { CommentRow, rowToComment } from "../../shared/db";
import type { TaskComment, ActorKind } from "../../shared/types";

export class CommentRepo extends Effect.Service<CommentRepo>()("Lexa/CommentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const insert = (input: { taskId: string; authorId: string | null; authorKind: ActorKind; authorLabel: string; body: string; viaHerald?: boolean }): Effect.Effect<TaskComment, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        yield* run(
          db,
          `INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, via_herald)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.taskId, input.authorId, input.authorKind, input.authorLabel, input.body,
          input.viaHerald === true ? 1 : 0
        );
        const row = yield* queryFirst<CommentRow>(
          db,
          `SELECT id, task_id, author_id, author_kind, author_label, body, via_herald, edited_at, deleted_at, created_at
           FROM task_comments WHERE id = last_insert_rowid()`
        ).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "comment row vanished after insert" })))
        );
        return rowToComment(row);
      });

    const findById = (id: number): Effect.Effect<TaskComment | null, DbError> =>
      queryFirst<CommentRow>(
        db,
        `SELECT id, task_id, author_id, author_kind, author_label, body, via_herald, edited_at, deleted_at, created_at
         FROM task_comments WHERE id = ?`,
        id
      ).pipe(
        Effect.map(rowToComment),
        Effect.catchTag("RowNotFound", () => Effect.succeed(null))
      );

    const updateBody = (id: number, body: string): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      queryFirst<CommentRow>(
        db,
        `UPDATE task_comments SET body = ?, edited_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
         RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`,
        body, id
      ).pipe(Effect.map(rowToComment));

    const softDelete = (id: number): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      queryFirst<CommentRow>(
        db,
        `UPDATE task_comments SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
         RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`,
        id
      ).pipe(Effect.map(rowToComment));

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<TaskComment[], DbError> =>
      queryAll<CommentRow>(
        db,
        `SELECT id, task_id, author_id, author_kind, author_label, body, via_herald, edited_at, deleted_at, created_at
         FROM task_comments
         WHERE task_id = ? AND deleted_at IS NULL
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.id ?? null, limit
      ).pipe(Effect.map((rows) => rows.map(rowToComment)));

    return { insert, findById, updateBody, softDelete, listByTaskKeyset };
  }),
}) {}

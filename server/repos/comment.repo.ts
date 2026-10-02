import { Effect } from "effect";
import { Db, queryAll, queryFirst, runReturning, type BatchStmt, type SqlParam, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { CommentRow, rowToComment } from "../../shared/db";
import type { TaskComment, ActorKind } from "../../shared/types";

export interface CommentInsertInput {
  taskId: string; authorId: string | null; authorKind: ActorKind; authorLabel: string;
  body: string; viaAssistant?: boolean;
}

const COMMENT_INSERT_SQL = `INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, via_assistant)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING id, task_id, author_id, author_kind, author_label, body, via_assistant, edited_at, deleted_at, created_at`;

const COMMENT_RETURNING_COLUMNS = "id, task_id, author_id, author_kind, author_label, body, via_assistant, edited_at, deleted_at, created_at";

const commentInsertParams = (input: CommentInsertInput): SqlParam[] => [
  input.taskId, input.authorId, input.authorKind, input.authorLabel, input.body,
  input.viaAssistant === true ? 1 : 0,
];

export class CommentRepo extends Effect.Service<CommentRepo>()("Lexa/CommentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const insertStmt = (input: CommentInsertInput): BatchStmt => ({
      sql: COMMENT_INSERT_SQL,
      params: commentInsertParams(input),
    });

    /** Conditional soft-delete builder — RETURNING kept so the batch result
     *  reports whether a live row was actually removed. */
    const softDeleteStmt = (id: number): BatchStmt => ({
      sql: `UPDATE task_comments SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
         RETURNING ${COMMENT_RETURNING_COLUMNS}`,
      params: [id],
    });

    const insert = (input: CommentInsertInput): Effect.Effect<TaskComment, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = yield* runReturning<CommentRow>(
          db,
          COMMENT_INSERT_SQL,
          ...commentInsertParams(input)
        ).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "comment row vanished after insert" })))
        );
        return rowToComment(row);
      });

    const findById = (id: number): Effect.Effect<TaskComment | null, DbError> =>
      queryFirst<CommentRow>(
        db,
        `SELECT id, task_id, author_id, author_kind, author_label, body, via_assistant, edited_at, deleted_at, created_at
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
        softDeleteStmt(id).sql,
        id
      ).pipe(Effect.map(rowToComment));

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<TaskComment[], DbError> =>
      queryAll<CommentRow>(
        db,
        `SELECT id, task_id, author_id, author_kind, author_label, body, via_assistant, edited_at, deleted_at, created_at
         FROM task_comments
         WHERE task_id = ? AND deleted_at IS NULL
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.id ?? null, limit
      ).pipe(Effect.map((rows) => rows.map(rowToComment)));

    return { insert, insertStmt, softDeleteStmt, findById, updateBody, softDelete, listByTaskKeyset };
  }),
}) {}

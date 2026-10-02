import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, type SqlParam, DbError, ConstraintViolation } from "../db/db";

export interface AttachmentRow {
  id: string;
  project_id: string;
  task_id: string | null;
  wiki_page_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface AttachmentInsertInput {
  id: string;
  projectId: string;
  taskId: string | null;
  wikiPageId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string | null;
}

const ATTACHMENT_INSERT_SQL = `INSERT INTO attachments (id, project_id, task_id, wiki_page_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Same insert, deduped on the natural key: a concurrent upload of identical
// bytes loses the UNIQUE(project_id, sha256) race quietly, and `RETURNING id`
// tells the caller whether THIS row was the winner.
const ATTACHMENT_INSERT_DEDUPE_SQL = `${ATTACHMENT_INSERT_SQL} ON CONFLICT(project_id, sha256) DO NOTHING RETURNING id`;

const attachmentInsertParams = (input: AttachmentInsertInput): SqlParam[] => [
  input.id, input.projectId, input.taskId, input.wikiPageId,
  input.filename, input.mimeType, input.sizeBytes,
  input.sha256, input.storageKey, input.uploadedBy,
];

export class AttachmentRepo extends Effect.Service<AttachmentRepo>()("Lexa/AttachmentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      insertStmt: (input: AttachmentInsertInput): BatchStmt => ({
        sql: ATTACHMENT_INSERT_SQL,
        params: attachmentInsertParams(input),
      }),

      insertDedupeStmt: (input: AttachmentInsertInput): BatchStmt => ({
        sql: ATTACHMENT_INSERT_DEDUPE_SQL,
        params: attachmentInsertParams(input),
      }),

      insert: (input: AttachmentInsertInput): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, ATTACHMENT_INSERT_SQL, ...attachmentInsertParams(input)).pipe(Effect.map(() => undefined)),

      findById: (id: string): Effect.Effect<AttachmentRow | null, DbError> =>
        queryFirst<AttachmentRow>(
          db,
          `SELECT * FROM attachments WHERE id = ?`,
          id
        ).pipe(
          Effect.map((row) => row),
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        ),

      findByProjectAndSha: (projectId: string, sha256: string): Effect.Effect<AttachmentRow | null, DbError> =>
        queryFirst<AttachmentRow>(
          db,
          `SELECT * FROM attachments WHERE project_id = ? AND sha256 = ?`,
          projectId, sha256
        ).pipe(
          Effect.map((row) => row),
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        ),

      findByTaskId: (taskId: string): Effect.Effect<AttachmentRow[], DbError> =>
        queryAll<AttachmentRow>(
          db,
          `SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
          taskId
        ),

      findByWikiPageId: (wikiPageId: string): Effect.Effect<AttachmentRow[], DbError> =>
        queryAll<AttachmentRow>(
          db,
          `SELECT * FROM attachments WHERE wiki_page_id = ? ORDER BY created_at ASC, id ASC`,
          wikiPageId
        ),

      deleteByIdStmt: (id: string): BatchStmt => ({ sql: `DELETE FROM attachments WHERE id = ?`, params: [id] }),

      deleteById: (id: string): Effect.Effect<boolean, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM attachments WHERE id = ?`, id).pipe(Effect.map((changes) => changes > 0)),

      countByStorageKey: (storageKey: string): Effect.Effect<number, DbError> =>
        queryFirst<{ c: number }>(
          db,
          `SELECT COUNT(*) AS c FROM attachments WHERE storage_key = ?`,
          storageKey
        ).pipe(
          Effect.map((row) => row.c),
          Effect.catchTag("RowNotFound", () => Effect.succeed(0))
        ),
    };
  }),
}) {}

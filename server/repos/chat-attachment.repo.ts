import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, type SqlParam, DbError, ConstraintViolation } from "../db/db";

// Chat attachments are per-thread conversation context — a separate table from
// `attachments` (project artifacts). No project dedupe, no activity rows.
export interface ChatAttachmentRow {
  id: string;
  project_id: string;
  document_type: string;
  document_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface ChatAttachmentInsertInput {
  id: string;
  projectId: string;
  documentType: string;
  documentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string | null;
}

const CHAT_ATTACHMENT_INSERT_SQL = `INSERT INTO chat_attachments (id, project_id, document_type, document_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const chatAttachmentInsertParams = (input: ChatAttachmentInsertInput): SqlParam[] => [
  input.id, input.projectId, input.documentType, input.documentId,
  input.filename, input.mimeType, input.sizeBytes,
  input.sha256, input.storageKey, input.uploadedBy,
];

export class ChatAttachmentRepo extends Effect.Service<ChatAttachmentRepo>()("Lexa/ChatAttachmentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      insertStmt: (input: ChatAttachmentInsertInput): BatchStmt => ({
        sql: CHAT_ATTACHMENT_INSERT_SQL,
        params: chatAttachmentInsertParams(input),
      }),

      insert: (input: ChatAttachmentInsertInput): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, CHAT_ATTACHMENT_INSERT_SQL, ...chatAttachmentInsertParams(input)).pipe(Effect.map(() => undefined)),

      findById: (id: string): Effect.Effect<ChatAttachmentRow | null, DbError> =>
        queryFirst<ChatAttachmentRow>(
          db,
          `SELECT * FROM chat_attachments WHERE id = ?`,
          id
        ).pipe(
          Effect.map((row) => row),
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        ),

      findByThread: (documentType: string, documentId: string): Effect.Effect<ChatAttachmentRow[], DbError> =>
        queryAll<ChatAttachmentRow>(
          db,
          `SELECT * FROM chat_attachments WHERE document_type = ? AND document_id = ? ORDER BY created_at ASC, id ASC`,
          documentType, documentId
        ),

      deleteById: (id: string): Effect.Effect<boolean, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM chat_attachments WHERE id = ?`, id).pipe(Effect.map((changes) => changes > 0)),

      deleteByThread: (documentType: string, documentId: string): Effect.Effect<number, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM chat_attachments WHERE document_type = ? AND document_id = ?`, documentType, documentId),

      countByStorageKey: (storageKey: string): Effect.Effect<number, DbError> =>
        queryFirst<{ c: number }>(
          db,
          `SELECT COUNT(*) AS c FROM chat_attachments WHERE storage_key = ?`,
          storageKey
        ).pipe(
          Effect.map((row) => row.c),
          Effect.catchTag("RowNotFound", () => Effect.succeed(0))
        ),
    };
  }),
}) {}

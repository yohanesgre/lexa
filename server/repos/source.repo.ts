import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, type SqlParam, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { DocumentSourceRow, rowToDocumentSource } from "../../shared/db";
import type { DocumentSource } from "../../shared/types";

export interface SourceCreateInput {
  id: string;
  projectId: string;
  documentType: "task" | "wiki";
  documentId: string;
  kind: "wiki" | "external";
  title: string;
  ref: string;
}

const SOURCE_CREATE_SQL = `INSERT INTO document_sources (id, project_id, document_type, document_id, kind, title, ref)
             VALUES (?, ?, ?, ?, ?, ?, ?)`;

const sourceCreateParams = (input: SourceCreateInput): SqlParam[] => [
  input.id, input.projectId, input.documentType, input.documentId, input.kind, input.title, input.ref,
];

export class SourceRepo extends Effect.Service<SourceRepo>()("Lexa/SourceRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      findById: (id: string): Effect.Effect<DocumentSource, RowNotFound | DbError> =>
        queryFirst<DocumentSourceRow>(db, `SELECT * FROM document_sources WHERE id = ?`, id).pipe(
          Effect.map(rowToDocumentSource)
        ),

      findByDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<DocumentSource[], DbError> =>
        queryAll<DocumentSourceRow>(
          db,
          `SELECT * FROM document_sources WHERE project_id = ? AND document_type = ? AND document_id = ? ORDER BY created_at`,
          projectId,
          documentType,
          documentId
        ).pipe(Effect.map((rows) => rows.map(rowToDocumentSource))),

      createStmt: (input: SourceCreateInput): BatchStmt => ({
        sql: SOURCE_CREATE_SQL,
        params: sourceCreateParams(input),
      }),

      create: (input: SourceCreateInput): Effect.Effect<DocumentSource, ConstraintViolation | RowNotFound | DbError> =>
        Effect.gen(function* () {
          yield* run(db, SOURCE_CREATE_SQL, ...sourceCreateParams(input));
          const row = yield* queryFirst<DocumentSourceRow>(db, `SELECT * FROM document_sources WHERE id = ?`, input.id);
          return rowToDocumentSource(row);
        }),

      deleteStmt: (id: string): BatchStmt => ({ sql: `DELETE FROM document_sources WHERE id = ?`, params: [id] }),

      delete: (id: string): Effect.Effect<number, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM document_sources WHERE id = ?`, id),
    };
  }),
}) {}

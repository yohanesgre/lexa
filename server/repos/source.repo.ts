import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { DocumentSourceRow, rowToDocumentSource } from "../../shared/db";
import type { DocumentSource } from "../../shared/types";

export class SourceRepo extends Effect.Service<SourceRepo>()("Lexa/SourceRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

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

      create: (input: {
        id: string;
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        kind: "wiki" | "external";
        title: string;
        ref: string;
      }): Effect.Effect<DocumentSource, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO document_sources (id, project_id, document_type, document_id, kind, title, ref)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.documentType,
            input.documentId,
            input.kind,
            input.title,
            input.ref
          );
          return rowToDocumentSource({
            id: input.id,
            project_id: input.projectId,
            document_type: input.documentType,
            document_id: input.documentId,
            kind: input.kind,
            title: input.title,
            ref: input.ref,
            created_at: new Date().toISOString(),
          });
        }),

      delete: (id: string): Effect.Effect<number, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM document_sources WHERE id = ?`, id),
    };
  }),
}) {}

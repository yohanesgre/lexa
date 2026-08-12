import { Effect } from "effect";
import { Sqlite, queryAll, run, DbError, ConstraintViolation } from "../db/database";
import { ForgeSessionRow } from "../../shared/db";
import type { ForgeProvider } from "../../shared/types";

export interface ForgeSessionInput {
  documentType: "task" | "wiki";
  documentId: string;
  runtimeId: string;
  runtimeSessionId: string;
  provider: ForgeProvider;
  agentId: string;
  skillId: string;
}

export class ForgeSessionRepo extends Effect.Service<ForgeSessionRepo>()("Lexa/ForgeSessionRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const selectRow = (documentType: string, documentId: string, runtimeId: string): Effect.Effect<ForgeSessionRow | null, DbError> =>
      queryAll<ForgeSessionRow>(
        db,
        `SELECT * FROM forge_sessions WHERE document_type = ? AND document_id = ? AND runtime_id = ?`,
        documentType,
        documentId,
        runtimeId
      ).pipe(Effect.map((rows) => rows[0] ?? null));

    return {
      upsert: (input: ForgeSessionInput): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO forge_sessions (document_type, document_id, runtime_id, runtime_session_id, provider, agent_id, skill_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (document_type, document_id, runtime_id) DO UPDATE SET
             runtime_session_id = excluded.runtime_session_id,
             provider = excluded.provider,
             agent_id = excluded.agent_id,
             skill_id = excluded.skill_id,
             updated_at = datetime('now')`,
          input.documentType,
          input.documentId,
          input.runtimeId,
          input.runtimeSessionId,
          input.provider,
          input.agentId,
          input.skillId
        ).pipe(Effect.map(() => undefined)),

      get: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<ForgeSessionRow | null, DbError> =>
        selectRow(documentType, documentId, runtimeId),

      listForDocument: (documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeSessionRow[], DbError> =>
        queryAll<ForgeSessionRow>(
          db,
          `SELECT * FROM forge_sessions WHERE document_type = ? AND document_id = ? ORDER BY updated_at DESC`,
          documentType,
          documentId
        ),

      remove: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `DELETE FROM forge_sessions WHERE document_type = ? AND document_id = ? AND runtime_id = ?`,
          documentType,
          documentId,
          runtimeId
        ).pipe(Effect.map(() => undefined)),

      // True when a task on this document+runtime is in flight (or waiting on
      // this runtime): its completion would re-write the mapping the user just
      // reset, silently undoing the reset. Queued rows without a runtime
      // (runtime_id NULL, not yet claimed) don't count — no run is in flight.
      hasActiveTask: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<boolean, DbError> =>
        queryAll<{ c: number }>(
          db,
          `SELECT COUNT(*) as c FROM forge_tasks
           WHERE document_type = ? AND document_id = ? AND runtime_id = ?
             AND status IN ('queued', 'running')`,
          documentType,
          documentId,
          runtimeId
        ).pipe(Effect.map((rows) => (rows[0]?.c ?? 0) > 0)),
    };
  }),
}) {}

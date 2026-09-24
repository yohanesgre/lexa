import { Effect } from "effect";
import { Db, queryAll, run, DbError, ConstraintViolation } from "../db/db";
import { RuntimeSessionRow } from "../../shared/db";
import type { AgentCli } from "../../shared/types";

export interface RuntimeSessionInput {
  documentType: "task" | "wiki";
  documentId: string;
  runtimeId: string;
  runtimeSessionId: string;
  provider: AgentCli;
  agentId: string;
  skillId: string;
}

export class RuntimeSessionRepo extends Effect.Service<RuntimeSessionRepo>()("Lexa/RuntimeSessionRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const selectRow = (documentType: string, documentId: string, runtimeId: string): Effect.Effect<RuntimeSessionRow | null, DbError> =>
      queryAll<RuntimeSessionRow>(
        db,
        `SELECT * FROM runtime_sessions WHERE document_type = ? AND document_id = ? AND runtime_id = ?`,
        documentType,
        documentId,
        runtimeId
      ).pipe(Effect.map((rows) => rows[0]! ?? null));

    return {
      upsert: (input: RuntimeSessionInput): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO runtime_sessions (document_type, document_id, runtime_id, runtime_session_id, provider, agent_id, skill_id)
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

      get: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<RuntimeSessionRow | null, DbError> =>
        selectRow(documentType, documentId, runtimeId),

      listForDocument: (documentType: "task" | "wiki", documentId: string): Effect.Effect<RuntimeSessionRow[], DbError> =>
        queryAll<RuntimeSessionRow>(
          db,
          `SELECT * FROM runtime_sessions WHERE document_type = ? AND document_id = ? ORDER BY updated_at DESC`,
          documentType,
          documentId
        ),

      remove: (documentType: "task" | "wiki", documentId: string, runtimeId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `DELETE FROM runtime_sessions WHERE document_type = ? AND document_id = ? AND runtime_id = ?`,
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
          `SELECT COUNT(*) as c FROM runtime_tasks
           WHERE document_type = ? AND document_id = ? AND runtime_id = ?
             AND status IN ('queued', 'running')`,
          documentType,
          documentId,
          runtimeId
        ).pipe(Effect.map((rows) => (rows[0]?.c ?? 0) > 0)),
    };
  }),
}) {}

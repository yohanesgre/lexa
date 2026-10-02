import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, batch, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { BatchStmt, SqlParam } from "../db/db";
import type { ProviderKind, AssistantModelRow } from "../../shared/assistant";

export interface AssistantModelDbRow {
  id: string;
  provider_id: string;
  model_id: string;
  kind: ProviderKind;
  priority: number;
  enabled: number;
  created_at: string;
}

function toDomain(row: AssistantModelDbRow): AssistantModelRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    kind: row.kind,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export interface AssistantModelCreateInput {
  id: string;
  providerId: string;
  modelId: string;
  kind: ProviderKind;
  priority?: number;
  enabled?: boolean;
}

const MODEL_INSERT_SQL = `INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)`;

const modelInsertParams = (input: AssistantModelCreateInput): SqlParam[] => [
  input.id, input.providerId, input.modelId, input.kind, input.priority ?? 0, input.enabled === true ? 1 : 0,
];

// Builds the same dynamic UPDATE as `update` without executing it; `null` when
// no column is set.
const buildUpdateModelStmt = (
  id: string,
  patch: { modelId?: string; kind?: ProviderKind; priority?: number; enabled?: boolean }
): BatchStmt | null => {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.modelId !== undefined) { sets.push("model_id = ?"); params.push(patch.modelId); }
  if (patch.kind !== undefined) { sets.push("kind = ?"); params.push(patch.kind); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
  if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
  if (sets.length === 0) return null;
  params.push(id);
  return { sql: `UPDATE assistant_models SET ${sets.join(", ")} WHERE id = ?`, params };
};

export class AssistantModelsRepo extends Effect.Service<AssistantModelsRepo>()("Lexa/AssistantModelsRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      createStmt: (input: AssistantModelCreateInput): BatchStmt => ({
        sql: MODEL_INSERT_SQL,
        params: modelInsertParams(input),
      }),

      updateStmt: buildUpdateModelStmt,

      create: (input: AssistantModelCreateInput): Effect.Effect<AssistantModelRow, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          MODEL_INSERT_SQL,
          ...modelInsertParams(input)
        ).pipe(
          Effect.flatMap(() => queryFirst<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE id = ?`, input.id)),
          Effect.map(toDomain)
        ),

      findByProviderAndModelId: (providerId: string, modelId: string): Effect.Effect<AssistantModelRow, RowNotFound | DbError> =>
        Effect.map(queryFirst<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? AND model_id = ?`, providerId, modelId), toDomain),

      getById: (id: string): Effect.Effect<AssistantModelRow, RowNotFound | DbError> =>
        Effect.map(queryFirst<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE id = ?`, id), toDomain),

      listByProvider: (providerId: string): Effect.Effect<AssistantModelRow[], DbError> =>
        Effect.map(queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId), (rows) => rows.map(toDomain)),

      listAll: (): Effect.Effect<AssistantModelRow[], DbError> =>
        Effect.map(queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models ORDER BY priority ASC, id ASC`), (rows) => rows.map(toDomain)),

      update: (id: string, patch: { modelId?: string; kind?: ProviderKind; priority?: number; enabled?: boolean }): Effect.Effect<AssistantModelRow, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const stmt = buildUpdateModelStmt(id, patch);
          if (stmt === null) return yield* Effect.map(queryFirst<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE id = ?`, id), toDomain);
          yield* run(db, stmt.sql, ...stmt.params);
          return yield* Effect.map(queryFirst<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE id = ?`, id), toDomain);
        }),

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<{ project_id: string; fallback_model_ids: string }>(db, `SELECT project_id, fallback_model_ids FROM assistant_settings`);
          const stmts: BatchStmt[] = [{ sql: `DELETE FROM assistant_models WHERE id = ?`, params: [id] }];
          for (const r of rows) {
            let ids: string[] = [];
            try { const v = JSON.parse(r.fallback_model_ids ?? "[]"); if (Array.isArray(v)) ids = v.filter((x: unknown) => typeof x === "string"); } catch {}
            if (!ids.includes(id)) continue;
            const next = ids.filter((x) => x !== id);
            stmts.push({ sql: `UPDATE assistant_settings SET fallback_model_ids = ?, updated_at = datetime('now') WHERE project_id = ?`, params: [JSON.stringify(next), r.project_id] });
          }
          yield* batch(db, stmts);
        }).pipe(Effect.map(() => undefined)),

      reorder: (providerId: string, orderedIds: string[]): Effect.Effect<AssistantModelRow[], ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId);
          const existingIds = new Set(rows.map((r) => r.id));
          if (orderedIds.length !== rows.length || orderedIds.some((id) => !existingIds.has(id))) {
            return yield* new RowNotFound({ table: "assistant_models" });
          }
          // Two-phase priority rewrite as one atomic batch: move every row to
          // a temp offset first, then to its final index, so a swap never
          // trips a (provider_id, priority) uniqueness check mid-sequence.
          const tempOffset = 100000;
          const stmts: BatchStmt[] = [];
          for (let i = 0; i < orderedIds.length; i++) {
            stmts.push({ sql: `UPDATE assistant_models SET priority = ? WHERE id = ? AND provider_id = ?`, params: [tempOffset + i, orderedIds[i]!, providerId] });
          }
          for (let i = 0; i < orderedIds.length; i++) {
            stmts.push({ sql: `UPDATE assistant_models SET priority = ? WHERE id = ? AND provider_id = ?`, params: [i, orderedIds[i]!, providerId] });
          }
          if (stmts.length > 0) yield* batch(db, stmts);
          const updated = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId);
          return updated.map(toDomain);
        }),
    };
  }),
}) {}

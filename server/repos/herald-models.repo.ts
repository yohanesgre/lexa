import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, batch, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { ProviderKind, HeraldModelRow } from "../../shared/herald";

export interface HeraldModelDbRow {
  id: string;
  provider_id: string;
  model_id: string;
  kind: ProviderKind;
  priority: number;
  enabled: number;
  created_at: string;
}

function toDomain(row: HeraldModelDbRow): HeraldModelRow {
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

export class HeraldModelsRepo extends Effect.Service<HeraldModelsRepo>()("Lexa/HeraldModelsRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: { id: string; providerId: string; modelId: string; kind: ProviderKind; priority?: number; enabled?: boolean }): Effect.Effect<HeraldModelRow, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO herald_models (id, provider_id, model_id, kind, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
          input.id, input.providerId, input.modelId, input.kind, input.priority ?? 0, input.enabled === false ? 0 : 1
        ).pipe(
          Effect.flatMap(() => queryFirst<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE id = ?`, input.id)),
          Effect.map(toDomain)
        ),

      getById: (id: string): Effect.Effect<HeraldModelRow, RowNotFound | DbError> =>
        Effect.map(queryFirst<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE id = ?`, id), toDomain),

      listByProvider: (providerId: string): Effect.Effect<HeraldModelRow[], DbError> =>
        Effect.map(queryAll<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId), (rows) => rows.map(toDomain)),

      listAll: (): Effect.Effect<HeraldModelRow[], DbError> =>
        Effect.map(queryAll<HeraldModelDbRow>(db, `SELECT * FROM herald_models ORDER BY priority ASC, id ASC`), (rows) => rows.map(toDomain)),

      update: (id: string, patch: { modelId?: string; kind?: ProviderKind; priority?: number; enabled?: boolean }): Effect.Effect<HeraldModelRow, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.modelId !== undefined) { sets.push("model_id = ?"); params.push(patch.modelId); }
          if (patch.kind !== undefined) { sets.push("kind = ?"); params.push(patch.kind); }
          if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
          if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
          if (sets.length === 0) return yield* Effect.map(queryFirst<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE id = ?`, id), toDomain);
          params.push(id);
          yield* run(db, `UPDATE herald_models SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* Effect.map(queryFirst<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE id = ?`, id), toDomain);
        }),

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(db, `DELETE FROM herald_models WHERE id = ?`, id);
          const rows = db.prepare(`SELECT project_id, fallback_model_ids FROM herald_settings`).all() as Array<{ project_id: string; fallback_model_ids: string }>;
          for (const r of rows) {
            let ids: string[] = [];
            try { const v = JSON.parse(r.fallback_model_ids ?? "[]"); if (Array.isArray(v)) ids = v.filter((x: unknown) => typeof x === "string"); } catch {}
            if (!ids.includes(id)) continue;
            const next = ids.filter((x) => x !== id);
            yield* run(db, `UPDATE herald_settings SET fallback_model_ids = ?, updated_at = datetime('now') WHERE project_id = ?`, JSON.stringify(next), r.project_id);
          }
        }).pipe(Effect.map(() => undefined)),

      reorder: (providerId: string, orderedIds: string[]): Effect.Effect<HeraldModelRow[], ConstraintViolation | DbError | RowNotFound> =>
        withTx(db,
          Effect.gen(function* () {
            const rows = yield* queryAll<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId);
            const existingIds = new Set(rows.map((r) => r.id));
            if (orderedIds.length !== rows.length || orderedIds.some((id) => !existingIds.has(id))) {
              return yield* Effect.fail(new RowNotFound({ table: "herald_models" }) as unknown as never);
            }
            const tempOffset = 100000;
            for (let i = 0; i < orderedIds.length; i++) {
              yield* run(db, `UPDATE herald_models SET priority = ? WHERE id = ? AND provider_id = ?`, tempOffset + i, orderedIds[i], providerId);
            }
            for (let i = 0; i < orderedIds.length; i++) {
              yield* run(db, `UPDATE herald_models SET priority = ? WHERE id = ? AND provider_id = ?`, i, orderedIds[i], providerId);
            }
            const updated = yield* queryAll<HeraldModelDbRow>(db, `SELECT * FROM herald_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, providerId);
            return updated.map(toDomain);
          })
        ),
    };
  }),
}) {}

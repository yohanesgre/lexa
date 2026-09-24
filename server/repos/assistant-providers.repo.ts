import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { AssistantProviderMasked, AssistantModelRow, ProviderKind } from "../../shared/assistant";

export interface AssistantProviderRow {
  id: string;
  label: string;
  base_url: string;
  api_key: string;
  created_at: string;
  updated_at: string;
}

interface AssistantModelDbRow {
  id: string;
  provider_id: string;
  model_id: string;
  kind: ProviderKind;
  priority: number;
  enabled: number;
  created_at: string;
}

function toMasked(row: AssistantProviderRow): AssistantProviderMasked {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    hasKey: row.api_key !== null && row.api_key !== "",
    keyMask: row.api_key ? `sk-…${row.api_key.slice(-4)}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toModelDomain(row: AssistantModelDbRow): AssistantModelRow {
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

export class AssistantProvidersRepo extends Effect.Service<AssistantProvidersRepo>()("Lexa/AssistantProvidersRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      create: (input: { id: string; label: string; baseUrl: string; apiKey: string }): Effect.Effect<AssistantProviderRow, ConstraintViolation | DbError | RowNotFound> =>
        run(db, `INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES (?, ?, ?, ?)`, input.id, input.label, input.baseUrl, input.apiKey).pipe(
          Effect.flatMap(() => queryFirst<AssistantProviderRow>(db, `SELECT * FROM assistant_providers WHERE id = ?`, input.id))
        ),

      getById: (id: string): Effect.Effect<AssistantProviderRow, RowNotFound | DbError> =>
        queryFirst<AssistantProviderRow>(db, `SELECT * FROM assistant_providers WHERE id = ?`, id),

      list: (): Effect.Effect<AssistantProviderRow[], DbError> =>
        queryAll<AssistantProviderRow>(db, `SELECT * FROM assistant_providers ORDER BY created_at ASC`),

      update: (id: string, patch: { label?: string; baseUrl?: string; apiKey?: string }): Effect.Effect<AssistantProviderRow, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
          if (patch.baseUrl !== undefined) { sets.push("base_url = ?"); params.push(patch.baseUrl); }
          if (patch.apiKey !== undefined) { sets.push("api_key = ?"); params.push(patch.apiKey); }
          if (sets.length === 0) return yield* queryFirst<AssistantProviderRow>(db, `SELECT * FROM assistant_providers WHERE id = ?`, id);
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE assistant_providers SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<AssistantProviderRow>(db, `SELECT * FROM assistant_providers WHERE id = ?`, id);
        }),

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM assistant_providers WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      maskedView: (id: string): Effect.Effect<AssistantProviderMasked, RowNotFound | DbError> =>
        Effect.gen(function* () {
          const row = yield* queryFirst<AssistantProviderRow>(db, `SELECT * FROM assistant_providers WHERE id = ?`, id);
          const masked = toMasked(row);
          const modelRows = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, id).pipe(
            Effect.catchAll(() => Effect.succeed([] as AssistantModelDbRow[]))
          );
          const models = modelRows.map((row) => {
            const m = toModelDomain(row);
            return { id: m.id, providerId: m.providerId, modelId: m.modelId, kind: m.kind, priority: m.priority, enabled: m.enabled, createdAt: m.createdAt };
          });
          return { ...masked, models } as AssistantProviderMasked;
        }),

      maskedList: (): Effect.Effect<AssistantProviderMasked[], DbError> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<AssistantProviderRow>(db, `SELECT * FROM assistant_providers ORDER BY created_at ASC`);
          const modelRows = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models ORDER BY priority ASC, id ASC`).pipe(
            Effect.catchAll(() => Effect.succeed([] as AssistantModelDbRow[]))
          );
          const byProvider = new Map<string, AssistantModelDbRow[]>();
          for (const mr of modelRows) {
            const arr = byProvider.get(mr.provider_id) ?? [];
            arr.push(mr);
            byProvider.set(mr.provider_id, arr);
          }
          return rows.map((r) => {
            const masked = toMasked(r);
            const models = (byProvider.get(r.id) ?? []).map((row) => {
              const m = toModelDomain(row);
              return { id: m.id, providerId: m.providerId, modelId: m.modelId, kind: m.kind, priority: m.priority, enabled: m.enabled, createdAt: m.createdAt };
            });
            return { ...masked, models } as AssistantProviderMasked;
          });
        }),
    };
  }),
}) {}

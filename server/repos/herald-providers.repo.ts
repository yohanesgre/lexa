import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { HeraldProviderMasked } from "../../shared/herald";

export interface HeraldProviderRow {
  id: string;
  label: string;
  base_url: string;
  api_key: string;
  created_at: string;
  updated_at: string;
}

function toMasked(row: HeraldProviderRow): HeraldProviderMasked {
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

export class HeraldProvidersRepo extends Effect.Service<HeraldProvidersRepo>()("Lexa/HeraldProvidersRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: { id: string; label: string; baseUrl: string; apiKey: string }): Effect.Effect<HeraldProviderRow, ConstraintViolation | DbError | RowNotFound> =>
        run(db, `INSERT INTO herald_providers (id, label, base_url, api_key) VALUES (?, ?, ?, ?)`, input.id, input.label, input.baseUrl, input.apiKey).pipe(
          Effect.flatMap(() => queryFirst<HeraldProviderRow>(db, `SELECT * FROM herald_providers WHERE id = ?`, input.id))
        ),

      getById: (id: string): Effect.Effect<HeraldProviderRow, RowNotFound | DbError> =>
        queryFirst<HeraldProviderRow>(db, `SELECT * FROM herald_providers WHERE id = ?`, id),

      list: (): Effect.Effect<HeraldProviderRow[], DbError> =>
        queryAll<HeraldProviderRow>(db, `SELECT * FROM herald_providers ORDER BY created_at ASC`),

      update: (id: string, patch: { label?: string; baseUrl?: string; apiKey?: string }): Effect.Effect<HeraldProviderRow, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
          if (patch.baseUrl !== undefined) { sets.push("base_url = ?"); params.push(patch.baseUrl); }
          if (patch.apiKey !== undefined) { sets.push("api_key = ?"); params.push(patch.apiKey); }
          if (sets.length === 0) return yield* queryFirst<HeraldProviderRow>(db, `SELECT * FROM herald_providers WHERE id = ?`, id);
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE herald_providers SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<HeraldProviderRow>(db, `SELECT * FROM herald_providers WHERE id = ?`, id);
        }),

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM herald_providers WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      maskedView: (id: string): Effect.Effect<HeraldProviderMasked, RowNotFound | DbError> =>
        Effect.map(queryFirst<HeraldProviderRow>(db, `SELECT * FROM herald_providers WHERE id = ?`, id), toMasked),

      maskedList: (): Effect.Effect<HeraldProviderMasked[], DbError> =>
        Effect.map(queryAll<HeraldProviderRow>(db, `SELECT * FROM herald_providers ORDER BY created_at ASC`), (rows) => rows.map(toMasked)),
    };
  }),
}) {}

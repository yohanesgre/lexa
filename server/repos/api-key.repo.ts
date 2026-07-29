import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { ApiKeyRow } from "../../shared/db";

export class ApiKeyRepo extends Effect.Service<ApiKeyRepo>()("Lexa/ApiKeyRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: { id: string; name: string; keyHash: string }): Effect.Effect<ApiKeyRow, DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db, `INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)`, input.id, input.name, input.keyHash);
          return yield* queryFirst<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE key_hash = ?`, input.keyHash);
        }),

      findByHash: (hash: string): Effect.Effect<ApiKeyRow, DbError | RowNotFound> =>
        queryFirst<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE key_hash = ?`, hash),

      touchIfStale: (id: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        Effect.map(run(db, `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))`, id), () => undefined),

      listAll: (): Effect.Effect<ApiKeyRow[], DbError> =>
        queryAll<ApiKeyRow>(db, `SELECT * FROM api_keys ORDER BY created_at DESC`),

      deleteById: (id: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* queryFirst<{ id: string }>(db, `SELECT id FROM api_keys WHERE id = ?`, id);
          yield* run(db, `DELETE FROM api_keys WHERE id = ?`, id);
        }),
    };
  }),
  dependencies: [],
}) {}

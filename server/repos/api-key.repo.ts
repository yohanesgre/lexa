import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { ApiKeyRow } from "../../shared/db";

export interface ApiKeyWithOwnerRow extends ApiKeyRow {
  owner_email: string | null;
  owner_name: string | null;
}

export class ApiKeyRepo extends Effect.Service<ApiKeyRepo>()("Lexa/ApiKeyRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      create: (input: { id: string; name: string; keyHash: string; userId: string | null }): Effect.Effect<ApiKeyRow, DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db, `INSERT INTO api_keys (id, name, key_hash, user_id) VALUES (?, ?, ?, ?)`, input.id, input.name, input.keyHash, input.userId);
          return yield* queryFirst<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE key_hash = ?`, input.keyHash);
        }),

      findByHash: (hash: string): Effect.Effect<ApiKeyRow, DbError | RowNotFound> =>
        queryFirst<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE key_hash = ?`, hash),

      touchIfStale: (id: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        Effect.map(run(db, `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))`, id), () => undefined),

      listAll: (): Effect.Effect<ApiKeyWithOwnerRow[], DbError> =>
        queryAll<ApiKeyWithOwnerRow>(
          db,
          `SELECT a.*, u.email AS owner_email, u.name AS owner_name
           FROM api_keys a
           LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.created_at DESC`
        ),

      listByUser: (userId: string): Effect.Effect<ApiKeyWithOwnerRow[], DbError> =>
        queryAll<ApiKeyWithOwnerRow>(
          db,
          `SELECT a.*, u.email AS owner_email, u.name AS owner_name
           FROM api_keys a
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.user_id = ?
           ORDER BY a.created_at DESC`,
          userId
        ),

      deleteById: (id: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* queryFirst<{ id: string }>(db, `SELECT id FROM api_keys WHERE id = ?`, id);
          yield* run(db, `DELETE FROM api_keys WHERE id = ?`, id);
        }),

      // Owner-scoped delete: a missing row or a row owned by someone else
      // both surface RowNotFound — no existence oracle.
      deleteOwn: (id: string, userId: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          const changed = yield* run(db, `DELETE FROM api_keys WHERE id = ? AND user_id = ?`, id, userId);
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "api_keys" }));
        }),
    };
  }),
  dependencies: [],
}) {}
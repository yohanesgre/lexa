import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { UserRow } from "../../shared/db";

export class UserRepo extends Effect.Service<UserRepo>()("Lexa/UserRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      findById: (id: string): Effect.Effect<UserRow, DbError | RowNotFound> =>
        queryFirst<UserRow>(db, `SELECT * FROM users WHERE id = ?`, id),

      findByEmail: (email: string): Effect.Effect<UserRow | null, DbError> =>
        queryAll<UserRow>(db, `SELECT * FROM users WHERE email = ? LIMIT 1`, email).pipe(
          Effect.map((rows) => rows[0]! ?? null)
        ),

      listAll: (): Effect.Effect<UserRow[], DbError> =>
        queryAll<UserRow>(db, `SELECT * FROM users ORDER BY created_at DESC`),

      updateName: (id: string, name: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* queryFirst<{ id: string }>(db, `SELECT id FROM users WHERE id = ?`, id);
          yield* run(db, `UPDATE users SET name = ? WHERE id = ?`, name, id);
        }),

      deleteById: (id: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* queryFirst<{ id: string }>(db, `SELECT id FROM users WHERE id = ?`, id);
          yield* run(db, `DELETE FROM users WHERE id = ?`, id);
        }),
    };
  }),
  dependencies: [],
}) {}

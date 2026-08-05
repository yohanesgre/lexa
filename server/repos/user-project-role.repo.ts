import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { UserProjectRoleRow } from "../../shared/db";

export class UserProjectRoleRepo extends Effect.Service<UserProjectRoleRepo>()("Lexa/UserProjectRoleRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      findByUserId: (userId: string): Effect.Effect<UserProjectRoleRow[], DbError> =>
        queryAll<UserProjectRoleRow>(db, `SELECT * FROM user_project_roles WHERE user_id = ? ORDER BY role, project_id`, userId),

      findByUserAndProject: (userId: string, projectId: string): Effect.Effect<UserProjectRoleRow | null, DbError> =>
        queryFirst<UserProjectRoleRow>(db, `SELECT * FROM user_project_roles WHERE user_id = ? AND project_id = ?`, userId, projectId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null as unknown as UserProjectRoleRow))
        ),

      setRole: (userId: string, projectId: string, role: "admin" | "member"): Effect.Effect<void, DbError | ConstraintViolation> =>
        withTx(
          db,
          Effect.gen(function* () {
            yield* run(db, `DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?`, userId, projectId);
            yield* run(db, `INSERT INTO user_project_roles (user_id, role, project_id) VALUES (?, ?, ?)`, userId, role, projectId);
          })
        ),

      removeAccess: (userId: string, projectId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        run(db, `DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?`, userId, projectId),

      findByProjectId: (projectId: string): Effect.Effect<UserProjectRoleRow[], DbError> =>
        queryAll<UserProjectRoleRow>(db, `SELECT * FROM user_project_roles WHERE project_id = ? ORDER BY role, user_id`, projectId),
    };
  }),
  dependencies: [],
}) {}

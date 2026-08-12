import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectRow, rowToProject } from "../../shared/db";
import type { DomainProject } from "../../shared/types";

export class ProjectRepo extends Effect.Service<ProjectRepo>()("Lexa/ProjectRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: { id: string; name: string; slug: string; description: string }): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO projects (id, name, slug, description) VALUES (?, ?, ?, ?)`,
          input.id,
          input.name,
          input.slug,
          input.description
        ).pipe(Effect.map(() => undefined)),

      findBySlug: (slug: string): Effect.Effect<DomainProject, RowNotFound | DbError> =>
        queryFirst<ProjectRow>(db, `SELECT * FROM projects WHERE slug = ?`, slug).pipe(Effect.map(rowToProject)),

      findById: (id: string): Effect.Effect<DomainProject, RowNotFound | DbError> =>
        queryFirst<ProjectRow>(db, `SELECT * FROM projects WHERE id = ?`, id).pipe(Effect.map(rowToProject)),

      list: (): Effect.Effect<DomainProject[], DbError> =>
        queryAll<ProjectRow>(db, `SELECT * FROM projects ORDER BY created_at DESC`).pipe(
          Effect.map((rows) => rows.map(rowToProject))
        ),

      update: (id: string, input: { name?: string; description?: string }): Effect.Effect<DomainProject, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) {
          sets.push("name = ?");
          params.push(input.name);
        }
        if (input.description !== undefined) {
          sets.push("description = ?");
          params.push(input.description);
        }
        if (sets.length === 0)
          return queryFirst<ProjectRow>(db, `SELECT * FROM projects WHERE id = ?`, id).pipe(Effect.map(rowToProject));
        sets.push("updated_at = datetime('now')");
        params.push(id);
        return run(db, `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, ...params).pipe(
          Effect.flatMap(() => queryFirst<ProjectRow>(db, `SELECT * FROM projects WHERE id = ?`, id)),
          Effect.map(rowToProject)
        );
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM projects WHERE id = ?`, id).pipe(Effect.map(() => undefined)),
    };
  }),
}) {}

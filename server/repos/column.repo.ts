import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ColumnRow, rowToColumn } from "../../shared/db";
import type { Column } from "../../shared/types";

export class ColumnRepo extends Effect.Service<ColumnRepo>()("Lexa/ColumnRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: {
        id: string;
        projectId: string;
        name: string;
        position: number;
        color?: string;
        wipLimit?: number | null;
        requiredFields?: string[];
        githubState?: "open" | "closed" | null;
      }): Effect.Effect<Column, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.name,
            input.position,
            input.color ?? "#6b7280",
            input.wipLimit ?? null,
            JSON.stringify(input.requiredFields ?? []),
            input.githubState ?? null
          );
          return yield* queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, input.id).pipe(
            Effect.map(rowToColumn)
          );
        }),

      findById: (id: string): Effect.Effect<Column, RowNotFound | DbError> =>
        queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id).pipe(Effect.map(rowToColumn)),

      findByProject: (projectId: string): Effect.Effect<Column[], DbError> =>
        queryAll<ColumnRow>(
          db,
          `SELECT * FROM columns WHERE project_id = ? ORDER BY position`,
          projectId
        ).pipe(Effect.map((rows) => rows.map(rowToColumn))),

      update: (
        id: string,
        input: {
          name?: string;
          position?: number;
          color?: string;
          wipLimit?: number | null;
          requiredFields?: string[];
          githubState?: "open" | "closed" | null;
        }
      ): Effect.Effect<Column, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) {
          sets.push("name = ?");
          params.push(input.name);
        }
        if (input.position !== undefined) {
          sets.push("position = ?");
          params.push(input.position);
        }
        if (input.color !== undefined) {
          sets.push("color = ?");
          params.push(input.color);
        }
        if (input.wipLimit !== undefined) {
          sets.push("wip_limit = ?");
          params.push(input.wipLimit);
        }
        if (input.requiredFields !== undefined) {
          sets.push("required_fields = ?");
          params.push(JSON.stringify(input.requiredFields));
        }
        if (input.githubState !== undefined) {
          sets.push("github_state = ?");
          params.push(input.githubState);
        }
        if (sets.length === 0)
          return queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id).pipe(Effect.map(rowToColumn));
        params.push(id);
        return run(db, `UPDATE columns SET ${sets.join(", ")} WHERE id = ?`, ...params).pipe(
          Effect.flatMap(() => queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id)),
          Effect.map(rowToColumn)
        );
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM columns WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(
          db,
          `SELECT COALESCE(MAX(position), -1) as mp FROM columns WHERE project_id = ?`,
          projectId
        ).pipe(Effect.map((rows) => rows[0]?.mp ?? -1)),
    };
  }),
}) {}

import { Effect } from "effect";
import { D1, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/d1";
import { SwimlaneRow, rowToSwimlane } from "../../shared/types";
import type { Swimlane } from "../../shared/types";

export class SwimlaneRepo extends Effect.Service<SwimlaneRepo>()("Lexa/SwimlaneRepo", {
  effect: Effect.gen(function* () {
    const db = yield* D1;

    return {
      create: (input: { id: string; projectId: string; name: string; description?: string; position: number }): Effect.Effect<Swimlane, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db,
            `INSERT INTO swimlanes (id, project_id, name, description, position) VALUES (?, ?, ?, ?, ?)`,
            input.id, input.projectId, input.name, input.description ?? "", input.position
          );
          return yield* queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, input.id)
            .pipe(Effect.map(rowToSwimlane));
        }),

      findById: (id: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(rowToSwimlane)),

      findByProject: (projectId: string): Effect.Effect<Swimlane[], DbError> =>
        queryAll<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE project_id = ? ORDER BY position`, projectId)
          .pipe(Effect.map((rows) => rows.map(rowToSwimlane))),

      update: (id: string, input: { name?: string; description?: string; position?: number }): Effect.Effect<Swimlane, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
        if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
        if (input.position !== undefined) { sets.push("position = ?"); params.push(input.position); }
        if (sets.length === 0)
          return queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(rowToSwimlane));
        params.push(id);
        return run(db, `UPDATE swimlanes SET ${sets.join(", ")} WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id)))
          .pipe(Effect.map(rowToSwimlane));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(db, `SELECT COALESCE(MAX(position), -1) as mp FROM swimlanes WHERE project_id = ?`, projectId)
          .pipe(Effect.map((rows) => rows[0]?.mp ?? -1)),
    };
  }),
}) {}

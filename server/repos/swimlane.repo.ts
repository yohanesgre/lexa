import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { SwimlaneRow, rowToSwimlane } from "../../shared/db";
import type { Swimlane } from "../../shared/types";

export class SwimlaneRepo extends Effect.Service<SwimlaneRepo>()("Lexa/SwimlaneRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: { id: string; projectId: string; name: string; description?: string; position: number; kind?: "backlog" | "milestone"; dueAt?: string | null }): Effect.Effect<Swimlane, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db,
            `INSERT INTO swimlanes (id, project_id, name, description, position, kind, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            input.id, input.projectId, input.name, input.description ?? "", input.position, input.kind ?? "milestone", input.dueAt ?? null
          );
          return yield* queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, input.id)
            .pipe(Effect.map(rowToSwimlane));
        }),

      findById: (id: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(rowToSwimlane)),

      findBacklog: (projectId: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE project_id = ? AND kind = 'backlog'`, projectId)
          .pipe(Effect.map(rowToSwimlane)),

      findByProject: (projectId: string): Effect.Effect<Swimlane[], DbError> =>
        queryAll<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE project_id = ? ORDER BY position`, projectId)
          .pipe(Effect.map((rows) => rows.map(rowToSwimlane))),

      update: (id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null }): Effect.Effect<Swimlane, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
        if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
        if (input.position !== undefined) { sets.push("position = ?"); params.push(input.position); }
        if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }
        if (sets.length === 0)
          return queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(rowToSwimlane));
        params.push(id);
        return run(db, `UPDATE swimlanes SET ${sets.join(", ")} WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id)))
          .pipe(Effect.map(rowToSwimlane));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      setArchived: (id: string, archivedAt: string | null): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        run(db, `UPDATE swimlanes SET archived_at = ? WHERE id = ?`, archivedAt, id)
          .pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: "Database error", cause: e })),
            Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id))
          )
          .pipe(Effect.map(rowToSwimlane)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(db, `SELECT COALESCE(MAX(position), -1) as mp FROM swimlanes WHERE project_id = ?`, projectId)
          .pipe(Effect.map((rows) => rows[0]?.mp ?? -1)),

      countTasks: (swimlaneId: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?`, swimlaneId).pipe(
          Effect.map((rows) => rows[0]?.c ?? 0)
        ),

      countDueAfter: (swimlaneId: string, dueAt: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(
          db,
          `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ? AND due_at IS NOT NULL AND due_at > ? AND archived_at IS NULL`,
          swimlaneId,
          dueAt
        ).pipe(Effect.map((rows) => rows[0]?.c ?? 0)),

      findFirstDueAfter: (swimlaneId: string, dueAt: string): Effect.Effect<{ id: string; title: string } | null, DbError> =>
        queryAll<{ id: string; title: string }>(
          db,
          `SELECT id, title FROM tasks WHERE swimlane_id = ? AND due_at IS NOT NULL AND due_at > ? AND archived_at IS NULL ORDER BY due_at ASC LIMIT 1`,
          swimlaneId,
          dueAt
        ).pipe(Effect.map((rows) => rows[0] ?? null)),
    };
  }),
}) {}

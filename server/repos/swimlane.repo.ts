import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, type SqlParam, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { SwimlaneRow, rowToSwimlane } from "../../shared/db";
import type { Swimlane } from "../../shared/types";

export interface SwimlaneCreateInput {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  position: number;
  kind?: "backlog" | "sprint";
  dueAt?: string | null;
  startAt?: string | null;
  milestoneId?: string | null;
}

const SWIMLANE_INSERT_SQL = `INSERT INTO swimlanes (id, project_id, name, description, position, kind, due_at, start_at, milestone_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Every swimlane read (list AND mutation readbacks) carries the task counts
// so the API is the single source of truth for X/Y progress — toggle-independent
// (archived tasks count done, archived lanes keep their totals).
export const SWIMLANE_SELECT_WITH_COUNTS = `
SELECT s.*,
  (SELECT COUNT(*) FROM tasks t
     WHERE t.project_id = s.project_id AND t.swimlane_id = s.id) AS tasks_total,
  (SELECT COUNT(*) FROM tasks t JOIN columns c ON c.id = t.column_id
     WHERE t.project_id = s.project_id AND t.swimlane_id = s.id
       AND (t.archived_at IS NOT NULL OR c.is_done = 1)) AS tasks_done
FROM swimlanes s`;

const swimlaneInsertParams = (input: SwimlaneCreateInput): SqlParam[] => [
  input.id, input.projectId, input.name, input.description ?? "", input.position, input.kind ?? "sprint", input.dueAt ?? null, input.startAt ?? null, input.milestoneId ?? null
];

export class SwimlaneRepo extends Effect.Service<SwimlaneRepo>()("Lexa/SwimlaneRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      createStmt: (input: SwimlaneCreateInput): BatchStmt => ({
        sql: SWIMLANE_INSERT_SQL,
        params: swimlaneInsertParams(input),
      }),

      create: (input: SwimlaneCreateInput): Effect.Effect<Swimlane, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db, SWIMLANE_INSERT_SQL, ...swimlaneInsertParams(input));
          return yield* queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.id = ?`, input.id)
            .pipe(Effect.map(rowToSwimlane));
        }),

      findById: (id: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.id = ?`, id).pipe(Effect.map(rowToSwimlane)),

      findBacklog: (projectId: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.project_id = ? AND s.kind = 'backlog'`, projectId)
          .pipe(Effect.map(rowToSwimlane)),

      findByProject: (projectId: string): Effect.Effect<Swimlane[], DbError> =>
        queryAll<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.project_id = ? ORDER BY s.position`, projectId)
          .pipe(Effect.map((rows) => rows.map(rowToSwimlane))),

      update: (id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null }): Effect.Effect<Swimlane, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
        if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
        if (input.position !== undefined) { sets.push("position = ?"); params.push(input.position); }
        if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }
        if (input.startAt !== undefined) { sets.push("start_at = ?"); params.push(input.startAt); }
        if (input.milestoneId !== undefined) { sets.push("milestone_id = ?"); params.push(input.milestoneId); }
        if (sets.length === 0)
          return queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.id = ?`, id).pipe(Effect.map(rowToSwimlane));
        params.push(id);
        return run(db, `UPDATE swimlanes SET ${sets.join(", ")} WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.id = ?`, id)))
          .pipe(Effect.map(rowToSwimlane));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM swimlanes WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      setArchived: (id: string, archivedAt: string | null): Effect.Effect<Swimlane, RowNotFound | DbError> =>
        run(db, `UPDATE swimlanes SET archived_at = ? WHERE id = ?`, archivedAt, id)
          .pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: "Database error", cause: e })),
            Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.id = ?`, id))
          )
          .pipe(Effect.map(rowToSwimlane)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(db, `SELECT COALESCE(MAX(position), -1) as mp FROM swimlanes WHERE project_id = ?`, projectId)
          .pipe(Effect.map((rows) => rows[0]!?.mp ?? -1)),

      countTasks: (swimlaneId: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?`, swimlaneId).pipe(
          Effect.map((rows) => rows[0]!?.c ?? 0)
        ),

      countDueAfter: (swimlaneId: string, dueAt: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(
          db,
          `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ? AND due_at IS NOT NULL AND due_at > ? AND archived_at IS NULL`,
          swimlaneId,
          dueAt
        ).pipe(Effect.map((rows) => rows[0]!?.c ?? 0)),

      findFirstDueAfter: (swimlaneId: string, dueAt: string): Effect.Effect<{ id: string; title: string } | null, DbError> =>
        queryAll<{ id: string; title: string }>(
          db,
          `SELECT id, title FROM tasks WHERE swimlane_id = ? AND due_at IS NOT NULL AND due_at > ? AND archived_at IS NULL ORDER BY due_at ASC LIMIT 1`,
          swimlaneId,
          dueAt
        ).pipe(Effect.map((rows) => rows[0]! ?? null)),
    };
  }),
}) {}

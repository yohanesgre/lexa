import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { MilestoneRow, SwimlaneRow, rowToMilestone, rowToSwimlane } from "../../shared/db";
import type { Milestone, Swimlane } from "../../shared/types";
import { SWIMLANE_SELECT_WITH_COUNTS } from "./swimlane.repo";

// Every milestone read (list AND mutation readbacks) carries the sprint
// counts so mutation responses never clobber list-derived FE cache state.
// Task counts are computed server-side: total includes archived tasks, done
// counts archived tasks and tasks in done columns (invariant 14).
const MILESTONE_SELECT_WITH_COUNTS = `
  SELECT m.*,
    (SELECT COUNT(*) FROM swimlanes s WHERE s.milestone_id = m.id) AS sprint_count,
    (SELECT COUNT(*) FROM swimlanes s WHERE s.milestone_id = m.id AND s.archived_at IS NOT NULL) AS archived_sprint_count,
    (SELECT COUNT(*) FROM tasks t JOIN swimlanes s ON t.swimlane_id = s.id
       WHERE s.milestone_id = m.id AND t.project_id = m.project_id) AS tasks_total,
    (SELECT COUNT(*) FROM tasks t JOIN swimlanes s ON t.swimlane_id = s.id JOIN columns c ON c.id = t.column_id
       WHERE s.milestone_id = m.id AND t.project_id = m.project_id
         AND (t.archived_at IS NOT NULL OR c.is_done = 1)) AS tasks_done
  FROM milestones m`;

export class MilestoneRepo extends Effect.Service<MilestoneRepo>()("Lexa/MilestoneRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      create: (input: { id: string; projectId: string; name: string; description?: string; position: number; dueAt?: string | null }): Effect.Effect<Milestone, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(db,
            `INSERT INTO milestones (id, project_id, name, description, position, due_at) VALUES (?, ?, ?, ?, ?, ?)`,
            input.id, input.projectId, input.name, input.description ?? "", input.position, input.dueAt ?? null
          );
          return yield* queryFirst<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.id = ?`, input.id)
            .pipe(Effect.map(rowToMilestone));
        }),

      findById: (id: string): Effect.Effect<Milestone, RowNotFound | DbError> =>
        queryFirst<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.id = ?`, id).pipe(Effect.map(rowToMilestone)),

      findByProject: (projectId: string): Effect.Effect<Milestone[], DbError> =>
        queryAll<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.project_id = ? ORDER BY m.position`, projectId)
          .pipe(Effect.map((rows) => rows.map(rowToMilestone))),

      update: (id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null }): Effect.Effect<Milestone, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
        if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
        if (input.position !== undefined) { sets.push("position = ?"); params.push(input.position); }
        if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }
        if (sets.length === 0)
          return queryFirst<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.id = ?`, id).pipe(Effect.map(rowToMilestone));
        params.push(id);
        return run(db, `UPDATE milestones SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.id = ?`, id)))
          .pipe(Effect.map(rowToMilestone));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM milestones WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      setArchived: (id: string, archivedAt: string | null): Effect.Effect<Milestone, RowNotFound | DbError> =>
        run(db, `UPDATE milestones SET archived_at = ?, updated_at = datetime('now') WHERE id = ?`, archivedAt, id)
          .pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: "Database error", cause: e })),
            Effect.flatMap(() => queryFirst<MilestoneRow>(db, `${MILESTONE_SELECT_WITH_COUNTS} WHERE m.id = ?`, id))
          )
          .pipe(Effect.map(rowToMilestone)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(db, `SELECT COALESCE(MAX(position), -1) as mp FROM milestones WHERE project_id = ?`, projectId)
          .pipe(Effect.map((rows) => rows[0]!?.mp ?? -1)),

      countSprints: (milestoneId: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM swimlanes WHERE milestone_id = ?`, milestoneId)
          .pipe(Effect.map((rows) => rows[0]!?.c ?? 0)),

      findByMilestone: (milestoneId: string): Effect.Effect<Swimlane[], DbError> =>
        queryAll<SwimlaneRow>(db, `${SWIMLANE_SELECT_WITH_COUNTS} WHERE s.milestone_id = ? ORDER BY s.position`, milestoneId)
          .pipe(Effect.map((rows) => rows.map(rowToSwimlane))),
    };
  }),
}) {}

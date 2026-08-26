// Batch-array builder for the milestone archive cascade (Phase 5).
//
// The Bun path's existing `milestone.service.ts` archive cascade is:
//   1. UPDATE milestones SET archived_at = ?
//   2. SELECT * FROM swimlanes WHERE milestone_id = ?
//   3. for each swimlane: UPDATE swimlanes SET archived_at = ?
//   4. for each swimlane: SELECT tasks WHERE swimlane_id = ?
//   5. for each task: UPDATE tasks + INSERT task_activity
//
// The D1 path re-expresses the same operation as a single `db.batch` call
// over a pre-computed array of `{ sql, params }` pairs. The shape is:
//
//   - 1 UPDATE milestones
//   - N UPDATE swimlanes (one per swimlane in the milestone)
//   - M x 2 (UPDATE tasks + INSERT task_activity) per task
//
// The cascade's pre-resolution (steps 2 + 4) is a separate SELECT the
// service runs OUTSIDE the batch (D1's batch is statements-only — it
// can't run SELECTs and return results). The builder takes the
// pre-resolved swimlane + task IDs as input.

import type { SqlParam } from "../db/driver";
import type { BatchStmt } from "./task-batch";

export interface MilestoneArchiveCascadeInput {
  milestoneId: string;
  archivedAt: string;            // ISO timestamp; null restore is a separate path
  /** Pre-resolved swimlanes that belong to this milestone. The
   *  service runs the SELECT (D1 doesn't return rows from `batch()`). */
  swimlanes: { id: string }[];
  /** Pre-resolved tasks per swimlane. The service runs the SELECT for
   *  each swimlane BEFORE calling the batch builder. */
  tasks: { id: string }[];
  actorKind: "user" | "agent" | "system";
  actorLabel: string;
  actorUserId: string | null;
  /** The human-readable archive message; passed to each task's
   *  activity row. */
  message: string;
  viaHerald: boolean;
}

export function buildMilestoneArchiveCascadeBatch(input: MilestoneArchiveCascadeInput): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  stmts.push({
    sql: `UPDATE milestones SET archived_at = ?, updated_at = ? WHERE id = ?`,
    params: [input.archivedAt, input.archivedAt, input.milestoneId],
  });
  for (const s of input.swimlanes) {
    stmts.push({
      sql: `UPDATE swimlanes SET archived_at = ?, updated_at = ? WHERE id = ?`,
      params: [input.archivedAt, input.archivedAt, s.id],
    });
  }
  for (const t of input.tasks) {
    stmts.push({
      sql: `UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`,
      params: [input.archivedAt, input.archivedAt, t.id],
    });
    stmts.push({
      sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_herald)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        t.id,
        input.actorKind,
        input.actorLabel,
        input.actorUserId,
        "archived",
        input.message,
        input.viaHerald ? 1 : 0,
      ],
    });
  }
  return stmts;
}

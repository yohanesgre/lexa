// Set-based archive-cascade builders.
//
// Each builder returns a CONSTANT number of statements regardless of cascade
// size — the per-task work is one `INSERT ... SELECT ... RETURNING` plus one
// scoped `UPDATE`, so a milestone with any number of sprints/tasks is a single
// atomic `batch()`/`batchResults()` call (D1 statement-cap safe). No read
// happens between statements; the only read the cascade needs is the
// service's pre-read of the lane/milestone.
//
// Ordering matters: the activity `INSERT ... SELECT` runs BEFORE the scoped
// task `UPDATE` so it selects exactly the tasks that were live at cascade
// start. The message is precomputed in TS and passed as a parameter (frozen at
// write time, invariant #12).
//
// Statement 0 of every returned array is the activity INSERT; its positional
// batch result holds the emitted rows. SQLite does not formally guarantee that
// `RETURNING` rows come back in the SELECT's `ORDER BY position, id` order, so
// callers map them through `activityFromBatchResults` — which sorts by the
// autoincrement `id` (insertion order follows the SELECT order) to make the
// response order deterministic without relying on the spec.

import type { BatchStmt } from "./task-batch";
import { rowToActivityEvent, type ActivityRow } from "../../shared/db";
import type { ActivityEvent } from "../../shared/types";
import type { LexaRow } from "../db/driver";

export interface CascadeActor {
  actorKind: "user" | "agent" | "system";
  actorLabel: string;
  actorUserId: string | null;
  /** Precomputed at write time (invariant #12). */
  message: string;
  viaAssistant: boolean;
}

const ACTIVITY_RETURNING = `id, task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant, created_at`;

/** Archive one swimlane and every live task in it, with one `archived`
 *  activity row per task. */
export function buildSwimlaneArchiveBatch(input: {
  swimlaneId: string;
  archivedAt: string;
  actor: CascadeActor;
}): BatchStmt[] {
  const a = input.actor;
  return [
    {
      sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
            SELECT id, ?, ?, ?, 'archived', ?, ?
              FROM tasks
             WHERE swimlane_id = ? AND archived_at IS NULL
             ORDER BY position, id
            RETURNING ${ACTIVITY_RETURNING}`,
      params: [a.actorKind, a.actorLabel, a.actorUserId, a.message, a.viaAssistant ? 1 : 0, input.swimlaneId],
    },
    {
      sql: `UPDATE tasks SET archived_at = ?, updated_at = datetime('now')
             WHERE swimlane_id = ? AND archived_at IS NULL`,
      params: [input.archivedAt, input.swimlaneId],
    },
    {
      sql: `UPDATE swimlanes SET archived_at = ? WHERE id = ?`,
      params: [input.archivedAt, input.swimlaneId],
    },
  ];
}

/** Archive one milestone, all its sprints, and every live task in those
 *  sprints, with one `archived` activity row per task. */
export function buildMilestoneArchiveBatch(input: {
  milestoneId: string;
  archivedAt: string;
  actor: CascadeActor;
}): BatchStmt[] {
  const a = input.actor;
  const sprintScope = `swimlane_id IN (SELECT id FROM swimlanes WHERE milestone_id = ?)`;
  return [
    {
      sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
            SELECT id, ?, ?, ?, 'archived', ?, ?
              FROM tasks
             WHERE archived_at IS NULL AND ${sprintScope}
             ORDER BY position, id
            RETURNING ${ACTIVITY_RETURNING}`,
      params: [a.actorKind, a.actorLabel, a.actorUserId, a.message, a.viaAssistant ? 1 : 0, input.milestoneId],
    },
    {
      sql: `UPDATE tasks SET archived_at = ?, updated_at = datetime('now')
             WHERE archived_at IS NULL AND ${sprintScope}`,
      params: [input.archivedAt, input.milestoneId],
    },
    {
      sql: `UPDATE swimlanes SET archived_at = ? WHERE milestone_id = ?`,
      params: [input.archivedAt, input.milestoneId],
    },
    {
      sql: `UPDATE milestones SET archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.archivedAt, input.milestoneId],
    },
  ];
}

/** Map the positional activity `INSERT ... SELECT ... RETURNING` result (from
 *  statement 0 of a cascade batch) to events in deterministic order: sort by
 *  the autoincrement `id`, which follows the insert (SELECT) order. */
export function activityFromBatchResults(results: LexaRow[]): ActivityEvent[] {
  return [...results]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((r) => rowToActivityEvent(r as unknown as ActivityRow));
}

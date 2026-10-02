// Batch-array builders for the atomic multi-statement writes.
//
// Each helper returns the `{ sql, params }[]` array that `db.batch()` /
// `db.batchResults()` consumes directly on BOTH drivers (bun-sqlite wraps
// the array in a transaction; D1 calls the binding's `batch()`). Converted
// services call `batch(db, buildXxxBatch(input))` / `batchResults(...)` and
// no longer use `withTx`; the remaining read-dependent `withTx` sites are
// tracked for a follow-up.
//
// These helpers are the single source of truth for both paths. They are
// pure functions of the input — no database access, no side effects —
// which makes them trivially testable.

import type { SqlParam } from "../db/driver";

/** A single batch statement — `db.batch()` / `batchResults()` consume this
 *  shape on BOTH drivers. */
export interface BatchStmt {
  sql: string;
  params: SqlParam[];
}

export interface ActivityInput {
  actorKind: "user" | "agent" | "system";
  actorLabel: string;
  actorUserId: string | null;
  type: string;
  message: string;
  viaAssistant: boolean;
}

export function buildActivityStmts(taskId: string, rows: ActivityInput[]): BatchStmt[] {
  return rows.map((r) => ({
    sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [taskId, r.actorKind, r.actorLabel, r.actorUserId, r.type, r.message, r.viaAssistant ? 1 : 0],
  }));
}

export function buildTaskCreateBatch(input: {
  id: string;
  projectId: string;
  columnId: string;
  swimlaneId: string;
  title: string;
  description: string;
  priority: string;
  type: string;
  position: string;
  dueAt: string | null;
  /** Ticket prefix (`projects.key`); `number`/`key` are computed inside the
   *  batch from the counter this same batch increments, so a failed insert
   *  rolls the increment back (no burned numbers). */
  projectKey: string;
  assignees: string[];
  subtaskOfParentId?: string | null;
  activity: ActivityInput[];
}): BatchStmt[] {
  const stmts: BatchStmt[] = [
    {
      sql: `UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ?`,
      params: [input.projectId],
    },
    {
      sql: `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, due_at, number, key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     (SELECT next_task_number FROM projects WHERE id = ?),
                     ? || '-' || (SELECT next_task_number FROM projects WHERE id = ?))`,
      params: [
        input.id, input.projectId, input.columnId, input.swimlaneId,
        input.title, input.description, input.priority, input.type,
        input.position, input.dueAt, input.projectId, input.projectKey, input.projectId,
      ],
    },
  ];
  for (const name of input.assignees) {
    stmts.push({
      sql: `INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)`,
      params: [input.id, name],
    });
  }
  if (input.subtaskOfParentId) {
    stmts.push({
      sql: `INSERT INTO task_links (id, project_id, from_task_id, to_task_id, relation)
             VALUES (?, ?, ?, ?, 'subtask_of')`,
      params: [crypto.randomUUID(), input.projectId, input.id, input.subtaskOfParentId],
    });
  }
  stmts.push(...buildActivityStmts(input.id, input.activity));
  return stmts;
}

export function buildTaskUpdateBatch(input: {
  id: string;
  title?: string;
  description?: string;
  priority?: string;
  type?: string;
  dueAt?: string | null;
  replaceAssignees?: string[] | null;
  activity: ActivityInput[];
}): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  if (input.replaceAssignees !== undefined && input.replaceAssignees !== null) {
    stmts.push({ sql: `DELETE FROM task_assignees WHERE task_id = ?`, params: [input.id] });
    for (const name of input.replaceAssignees) {
      stmts.push({
        sql: `INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)`,
        params: [input.id, name],
      });
    }
  }
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (input.title !== undefined) { sets.push("title = ?"); params.push(input.title); }
  if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
  if (input.priority !== undefined) { sets.push("priority = ?"); params.push(input.priority); }
  if (input.type !== undefined) { sets.push("type = ?"); params.push(input.type); }
  if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(input.id);
    stmts.push({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params });
  }
  stmts.push(...buildActivityStmts(input.id, input.activity));
  return stmts;
}

export function buildWipMoveStmt(input: {
  taskId: string;
  projectId: string;
  columnId: string;
  swimlaneId: string;
  position: string;
  clearDueAt: boolean;
}): BatchStmt {
  const clearDue = input.clearDueAt ? ", due_at = NULL" : "";
  return {
    sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?${clearDue}, updated_at = datetime('now')
           WHERE id = ?
             AND (column_id = ? OR (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND column_id = ? AND archived_at IS NULL) < COALESCE((SELECT wip_limit FROM columns WHERE id = ?), 9223372036854775807))`,
    params: [
      input.columnId, input.swimlaneId, input.position, input.taskId,
      input.columnId, input.projectId, input.columnId, input.columnId,
    ],
  };
}

export function buildPlainMoveStmts(moves: { taskId: string; columnId: string; swimlaneId: string; position: string; clearDueAt?: boolean }[]): BatchStmt[] {
  return moves.map((m) => ({
    sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?${m.clearDueAt ? ", due_at = NULL" : ""}, updated_at = datetime('now') WHERE id = ?`,
    params: [m.columnId, m.swimlaneId, m.position, m.taskId],
  }));
}

export function buildWebhookMoveAndEmitBatch(input: {
  taskId: string;
  issueId: string;
  columnId: string;
  swimlaneId: string;
  position: string;
  syncedState: "open" | "closed";
  activity: ActivityInput | null;
}): BatchStmt[] {
  const stmts: BatchStmt[] = [
    {
      sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.columnId, input.swimlaneId, input.position, input.taskId],
    },
    {
      sql: `UPDATE task_github_issues SET synced_state = ? WHERE task_id = ? AND issue_id = ?`,
      params: [input.syncedState, input.taskId, input.issueId],
    },
  ];
  if (input.activity) stmts.push(...buildActivityStmts(input.taskId, [input.activity]));
  return stmts;
}

export function buildTaskDeleteBatch(input: { taskId: string }): BatchStmt[] {
  return [{ sql: `DELETE FROM tasks WHERE id = ?`, params: [input.taskId] }];
}

export function buildTaskArchiveBatch(input: {
  taskId: string;
  archivedAt: string | null;
  activity: ActivityInput;
}): BatchStmt[] {
  return [
    {
      sql: `UPDATE tasks SET archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.archivedAt, input.taskId],
    },
    ...buildActivityStmts(input.taskId, [input.activity]),
  ];
}

export function buildUnlinkBatch(input: {
  taskId: string;
  issueId: string;
  activity: ActivityInput | null;
}): BatchStmt[] {
  const stmts: BatchStmt[] = [
    { sql: `DELETE FROM task_github_issues WHERE task_id = ? AND issue_id = ?`, params: [input.taskId, input.issueId] },
  ];
  if (input.activity) stmts.push(...buildActivityStmts(input.taskId, [input.activity]));
  return stmts;
}

/** Build the batch for: update a task's archive state + emit one
 *  `archived` (or `restored`) activity row. Both drivers run it via
 *  `db.batch(stmts)` — one atomic batch. */
export function buildSetArchivedAndEmitBatch(input: {
  taskId: string;
  archivedAt: string | null;   // null = restore
  actorKind: "user" | "agent" | "system";
  actorLabel: string;
  actorUserId: string | null;
  archivedMessage: string;     // "X archived this task" or "X restored this task"
  restoredMessage: string;
  viaAssistant: boolean;
}): BatchStmt[] {
  const type = input.archivedAt ? "archived" : "restored";
  const message = input.archivedAt ? input.archivedMessage : input.restoredMessage;
  return [
    {
      sql: `UPDATE tasks SET archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.archivedAt, input.taskId],
    },
    {
      sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.taskId,
        input.actorKind,
        input.actorLabel,
        input.actorUserId,
        type,
        message,
        input.viaAssistant ? 1 : 0,
      ],
    },
  ];
}

/** Build the batch for: the webhook move (UPDATE tasks + UPDATE
 *  task_github_issues synced_state). The plan's #2 invariant requires
 *  both writes to land atomically — a single `db.batch(stmts)` call on
 *  either driver. */
export function buildWebhookMoveBatch(input: {
  taskId: string;
  issueId: string;
  columnId: string;
  swimlaneId: string;
  position: string;
  syncedState: "open" | "closed";
}): BatchStmt[] {
  return [
    {
      sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.columnId, input.swimlaneId, input.position, input.taskId],
    },
    {
      sql: `UPDATE task_github_issues SET synced_state = ? WHERE task_id = ? AND issue_id = ?`,
      params: [input.syncedState, input.taskId, input.issueId],
    },
  ];
}

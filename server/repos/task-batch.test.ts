// Tests for the batch-array builders in `task-batch.ts`. The
// builders are pure functions of the input — these tests verify the
// atomicity/emission guards the services run through `db.batch(stmts)`:
// invariants #2/#3 (webhook move + synced-state in one batch), #5 (WIP move as
// one conditional UPDATE) and #12 (every activity write paired with the data
// write in the same batch).

import { describe, expect, it } from "vitest";
import {
  buildSetArchivedAndEmitBatch,
  buildTaskArchiveBatch,
  buildTaskCreateBatch,
  buildTaskDeleteBatch,
  buildTaskUpdateBatch,
  buildWebhookMoveAndEmitBatch,
  buildWebhookMoveBatch,
  buildWipMoveStmt,
} from "./task-batch";

describe("buildSetArchivedAndEmitBatch", () => {
  it("pairs the UPDATE tasks write with the task_activity insert in one batch (#12)", () => {
    const stmts = buildSetArchivedAndEmitBatch({
      taskId: "t1",
      archivedAt: "2026-08-25T10:00:00Z",
      actorKind: "user",
      actorLabel: "Maria",
      actorUserId: "u1",
      archivedMessage: "Maria archived this task",
      restoredMessage: "Maria restored this task",
      viaAssistant: false,
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\) WHERE id = \?/);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[1]!.params).toEqual([
      "t1",
      "user",
      "Maria",
      "u1",
      "archived",
      "Maria archived this task",
      0,
    ]);
  });
});

describe("buildWebhookMoveBatch", () => {
  it("pairs the task move with the github-issue synced-state update in one batch (#2/#3)", () => {
    const stmts = buildWebhookMoveBatch({
      taskId: "t1",
      issueId: "i_node_1",
      columnId: "c-done",
      swimlaneId: "s1",
      position: "a0",
      syncedState: "closed",
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET column_id = \?, swimlane_id = \?, position = \?, updated_at = datetime\('now'\) WHERE id = \?/);
    expect(stmts[1]!.sql).toMatch(/UPDATE task_github_issues SET synced_state = \? WHERE task_id = \? AND issue_id = \?/);
    expect(stmts[1]!.params).toEqual(["closed", "t1", "i_node_1"]);
  });
});

describe("emission builders (B2 batch re-expression)", () => {
  const actor = {
    actorKind: "user" as const,
    actorLabel: "Maria",
    actorUserId: "u1",
    type: "created",
    message: "Maria created this task",
    viaAssistant: false,
  };

  it("buildTaskCreateBatch: task + assignees + subtask link + activity, in order (#12)", () => {
    const stmts = buildTaskCreateBatch({
      id: "t1",
      projectId: "p1",
      columnId: "c1",
      swimlaneId: "s1",
      title: "T",
      description: "{}",
      priority: "prio-1",
      type: "type-1",
      position: "a0",
      dueAt: null,
      projectKey: "EG",
      assignees: ["Maria", "Jo"],
      subtaskOfParentId: "parent-1",
      activity: [actor],
    });
    expect(stmts).toHaveLength(6);
    expect(stmts[0]!.sql).toMatch(/UPDATE projects SET next_task_number = next_task_number \+ 1/);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO tasks/);
    expect(stmts[4]!.sql).toMatch(/INSERT INTO task_links/);
    expect(stmts[5]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[5]!.params).toEqual(["t1", "user", "Maria", "u1", "created", "Maria created this task", 0]);
  });

  it("buildTaskUpdateBatch: assignee replace + scalar sets + activity", () => {
    const stmts = buildTaskUpdateBatch({
      id: "t1",
      title: "New",
      dueAt: null,
      replaceAssignees: ["Jo"],
      activity: [{ ...actor, type: "field_changed", message: "Maria changed the title" }],
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      expect.stringMatching(/DELETE FROM task_assignees/),
      expect.stringMatching(/INSERT INTO task_assignees/),
      expect.stringMatching(/UPDATE tasks SET title = \?, due_at = \?, updated_at = datetime\('now'\) WHERE id = \?/),
      expect.stringMatching(/INSERT INTO task_activity/),
    ]);
  });

  it("buildWipMoveStmt keeps the WIP limit as one conditional UPDATE statement (#5)", () => {
    const stmt = buildWipMoveStmt({
      taskId: "t1", projectId: "p1", columnId: "c2", swimlaneId: "s1", position: "a1", clearDueAt: true,
    });
    expect(stmt.sql).toMatch(/due_at = NULL/);
    // The limit is enforced inside the same UPDATE: the move only applies when
    // the destination column is under its wip_limit (or has none).
    expect(stmt.sql).toMatch(/SELECT COUNT\(\*\) FROM tasks/);
    expect(stmt.sql).toMatch(/COALESCE\(\(SELECT wip_limit FROM columns WHERE id = \?\), 9223372036854775807\)/);
    const plain = buildWipMoveStmt({ taskId: "t1", projectId: "p1", columnId: "c2", swimlaneId: "s1", position: "a1", clearDueAt: false });
    expect(plain.sql).not.toMatch(/due_at = NULL/);
  });

  it("buildWebhookMoveAndEmitBatch: move + synced-state + github_synced activity in one batch (#2/#3)", () => {
    const stmts = buildWebhookMoveAndEmitBatch({
      taskId: "t1", issueId: "i1", columnId: "c2", swimlaneId: "s1",
      position: "a0", syncedState: "closed",
      activity: { actorKind: "system", actorLabel: "github", actorUserId: null, type: "github_synced", message: "GitHub synced #7 → closed", viaAssistant: false },
    });
    expect(stmts).toHaveLength(3);
    expect(stmts[1]!.params).toEqual(["closed", "t1", "i1"]);
    expect(stmts[2]!.params).toEqual(["t1", "system", "github", null, "github_synced", "GitHub synced #7 → closed", 0]);
  });

  it("buildTaskDeleteBatch emits only the DELETE (the activity row cascades) (#12)", () => {
    const stmts = buildTaskDeleteBatch({ taskId: "t1" });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/DELETE FROM tasks WHERE id = \?/);
    expect(stmts[0]!.params).toEqual(["t1"]);
  });

  it("buildTaskArchiveBatch pairs the archive UPDATE with its activity row", () => {
    const stmts = buildTaskArchiveBatch({ taskId: "t1", archivedAt: "now", activity: { ...actor, type: "archived", message: "x" } });
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\) WHERE id = \?/);
    expect(stmts[0]!.params).toEqual(["now", "t1"]);
    expect(stmts).toHaveLength(2);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO task_activity/);
  });
});

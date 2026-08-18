import { describe, expect, it } from "vitest";
import { sprintProgress, isSprintReadyToArchive, milestoneTaskProgress } from "./progress";
import type { Board, Swimlane, Task, Column } from "../../shared/types";

function col(id: string, isDone = false): Column {
  return { id, projectId: "p1", name: id, position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone };
}

function lane(id: string, milestoneId: string | null = null): Swimlane {
  return { id, projectId: "p1", name: id, description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId };
}

function task(id: string, swimlaneId: string, columnId: string, archivedAt: string | null = null): Task {
  return {
    id, key: "EG-1", projectId: "p1", columnId, swimlaneId, title: id, description: { type: "doc", content: [] },
    priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null,
    archivedAt, createdAt: "t", updatedAt: "t",
  };
}

function board(columns: Column[], swimlanes: Swimlane[], tasks: Task[]): Board {
  return {
    project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns, swimlanes, milestones: [], fieldConfig: { priorities: [], types: [] }, links: [], tasks,
  };
}

describe("sprintProgress", () => {
  it("counts tasks in a done column as done", () => {
    const b = board(
      [col("c1", true), col("c2")],
      [lane("s1")],
      [task("t1", "s1", "c1"), task("t2", "s1", "c2")]
    );
    expect(sprintProgress(b, "s1")).toEqual({ done: 1, total: 2 });
  });

  it("counts archived tasks as done regardless of column", () => {
    const b = board(
      [col("c1"), col("c2")],
      [lane("s1")],
      [task("t1", "s1", "c1", "2026-01-01"), task("t2", "s1", "c1")]
    );
    expect(sprintProgress(b, "s1")).toEqual({ done: 1, total: 2 });
  });

  it("counts archived OR done-column (both paths, no double count)", () => {
    const b = board(
      [col("c1", true)],
      [lane("s1")],
      [task("t1", "s1", "c1", "2026-01-01"), task("t2", "s1", "c1")]
    );
    expect(sprintProgress(b, "s1")).toEqual({ done: 2, total: 2 });
  });

  it("done tasks in non-done columns do NOT count", () => {
    const b = board(
      [col("c1"), col("c2")],
      [lane("s1")],
      [task("t1", "s1", "c1"), task("t2", "s1", "c2")]
    );
    expect(sprintProgress(b, "s1")).toEqual({ done: 0, total: 2 });
  });

  it("0/0 never reports ready", () => {
    const b = board([col("c1", true)], [lane("s1")], []);
    expect(sprintProgress(b, "s1")).toEqual({ done: 0, total: 0 });
    expect(isSprintReadyToArchive({ done: 0, total: 0 })).toBe(false);
  });

  it("excludes tasks from other swimlanes", () => {
    const b = board(
      [col("c1", true)],
      [lane("s1"), lane("s2")],
      [task("t1", "s1", "c1"), task("t2", "s2", "c1")]
    );
    expect(sprintProgress(b, "s1")).toEqual({ done: 1, total: 1 });
  });

  it("ready only at 100% with total > 0", () => {
    expect(isSprintReadyToArchive({ done: 8, total: 12 })).toBe(false);
    expect(isSprintReadyToArchive({ done: 12, total: 12 })).toBe(true);
  });
});

describe("milestoneTaskProgress", () => {
  it("aggregates tasks across the milestone's sprints", () => {
    const b = board(
      [col("c1", true), col("c2")],
      [lane("s1", "m1"), lane("s2", "m1"), lane("s3")],
      [task("t1", "s1", "c1"), task("t2", "s2", "c2"), task("t3", "s3", "c1")]
    );
    expect(milestoneTaskProgress(b, "m1")).toEqual({ done: 1, total: 2 });
  });
});

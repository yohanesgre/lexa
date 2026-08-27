import { describe, expect, it } from "vitest";
import { buildMilestoneArchiveCascadeBatch } from "./milestone-batch";

describe("buildMilestoneArchiveCascadeBatch", () => {
  it("returns 1 milestone + 1 swimlane + 2*(1 task) statements for a single-sprint, single-task milestone", () => {
    const stmts = buildMilestoneArchiveCascadeBatch({
      milestoneId: "m1",
      archivedAt: "2026-08-25T10:00:00Z",
      swimlanes: [{ id: "s1" }],
      tasks: [{ id: "t1" }],
      actorKind: "user",
      actorLabel: "Maria",
      actorUserId: "u1",
      message: "Maria archived this milestone",
      viaHerald: false,
    });
    expect(stmts).toHaveLength(4);
    expect(stmts[0]!.sql).toMatch(/UPDATE milestones SET archived_at/);
    expect(stmts[0]!.params).toEqual(["2026-08-25T10:00:00Z", "2026-08-25T10:00:00Z", "m1"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE swimlanes SET archived_at/);
    expect(stmts[1]!.params).toEqual(["2026-08-25T10:00:00Z", "2026-08-25T10:00:00Z", "s1"]);
    expect(stmts[2]!.sql).toMatch(/UPDATE tasks SET archived_at/);
    expect(stmts[3]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[3]!.params[4]!).toBe("archived");
  });

  it("scales linearly: N swimlanes + M tasks = 1 + N + 2*M statements", () => {
    const stmts = buildMilestoneArchiveCascadeBatch({
      milestoneId: "m1",
      archivedAt: "2026-08-25T10:00:00Z",
      swimlanes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }, { id: "t5" }],
      actorKind: "agent",
      actorLabel: "hearth-herald",
      actorUserId: null,
      message: "hearth-herald archived this milestone",
      viaHerald: true,
    });
    expect(stmts).toHaveLength(1 + 3 + 2 * 5);
    const inserts = stmts.filter((s) => s.sql.startsWith("INSERT INTO task_activity"));
    for (const i of inserts) {
      expect(i.params[6]!).toBe(1);
    }
  });

  it("returns only the milestone UPDATE when no swimlanes/tasks", () => {
    const stmts = buildMilestoneArchiveCascadeBatch({
      milestoneId: "m1",
      archivedAt: "2026-08-25T10:00:00Z",
      swimlanes: [],
      tasks: [],
      actorKind: "user",
      actorLabel: "Maria",
      actorUserId: "u1",
      message: "x",
      viaHerald: false,
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/UPDATE milestones/);
  });
});

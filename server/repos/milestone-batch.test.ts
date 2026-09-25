import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { buildMilestoneArchiveCascadeBatch } from "./milestone-batch";

function seedDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE milestones (id TEXT PRIMARY KEY, archived_at TEXT, updated_at TEXT);
    CREATE TABLE swimlanes (id TEXT PRIMARY KEY, archived_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, archived_at TEXT, updated_at TEXT);
    CREATE TABLE task_activity (task_id TEXT, actor_kind TEXT, actor_label TEXT, actor_user_id TEXT, type TEXT, message TEXT, via_assistant INTEGER);
  `);
  return db;
}

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
      viaAssistant: false,
    });
    expect(stmts).toHaveLength(4);
    expect(stmts[0]!.sql).toMatch(/UPDATE milestones SET archived_at = \?, updated_at = datetime\('now'\)/);
    expect(stmts[0]!.params).toEqual(["2026-08-25T10:00:00Z", "m1"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE swimlanes SET archived_at = \? WHERE id = \?/);
    expect(stmts[1]!.sql).not.toMatch(/updated_at/);
    expect(stmts[1]!.params).toEqual(["2026-08-25T10:00:00Z", "s1"]);
    expect(stmts[2]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\)/);
    expect(stmts[2]!.params).toEqual(["2026-08-25T10:00:00Z", "t1"]);
    expect(stmts[3]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[3]!.params[4]!).toBe("archived");
  });

  it("executes against the real schema shape (no removed updated_at column)", () => {
    const db = seedDb();
    try {
      db.exec(`
        INSERT INTO milestones (id) VALUES ('m1');
        INSERT INTO swimlanes (id) VALUES ('s1');
        INSERT INTO tasks (id) VALUES ('t1');
      `);
      const stmts = buildMilestoneArchiveCascadeBatch({
        milestoneId: "m1",
        archivedAt: "2026-08-25T10:00:00Z",
        swimlanes: [{ id: "s1" }],
        tasks: [{ id: "t1" }],
        actorKind: "user",
        actorLabel: "Maria",
        actorUserId: "u1",
        message: "Maria archived this milestone",
        viaAssistant: false,
      });
      db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();
      const milestone = db.query("SELECT archived_at, updated_at FROM milestones WHERE id = 'm1'").get() as { archived_at: string; updated_at: string };
      expect(milestone.archived_at).toBe("2026-08-25T10:00:00Z");
      expect(milestone.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const swimlane = db.query("SELECT archived_at FROM swimlanes WHERE id = 's1'").get() as { archived_at: string };
      expect(swimlane.archived_at).toBe("2026-08-25T10:00:00Z");
      const task = db.query("SELECT archived_at, updated_at FROM tasks WHERE id = 't1'").get() as { archived_at: string; updated_at: string };
      expect(task.archived_at).toBe("2026-08-25T10:00:00Z");
      expect(task.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      const activity = db.query("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number };
      expect(activity.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("scales linearly: N swimlanes + M tasks = 1 + N + 2*M statements", () => {
    const stmts = buildMilestoneArchiveCascadeBatch({
      milestoneId: "m1",
      archivedAt: "2026-08-25T10:00:00Z",
      swimlanes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }, { id: "t5" }],
      actorKind: "agent",
      actorLabel: "assistant",
      actorUserId: null,
      message: "assistant archived this milestone",
      viaAssistant: true,
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
      viaAssistant: false,
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/UPDATE milestones/);
  });
});

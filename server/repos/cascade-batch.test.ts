import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { buildSwimlaneArchiveBatch, buildMilestoneArchiveBatch } from "./cascade-batch";

const actor = {
  actorKind: "user" as const,
  actorLabel: "Maria",
  actorUserId: "u1",
  message: "Maria archived this task",
  viaAssistant: false,
};

describe("cascade-batch builders", () => {
  it("swimlane: constant 3 statements — activity INSERT...SELECT first, scoped task update, lane update without updated_at", () => {
    const stmts = buildSwimlaneArchiveBatch({ swimlaneId: "s1", archivedAt: "2026-08-25T10:00:00Z", actor });
    expect(stmts).toHaveLength(3);
    expect(stmts[0]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[0]!.sql).toMatch(/SELECT id, \?, \?, \?, 'archived', \?, \?/);
    expect(stmts[0]!.sql).toMatch(/archived_at IS NULL/);
    expect(stmts[0]!.sql).toMatch(/RETURNING id, task_id/);
    expect(stmts[0]!.params).toEqual(["user", "Maria", "u1", "Maria archived this task", 0, "s1"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\)/);
    expect(stmts[1]!.params).toEqual(["2026-08-25T10:00:00Z", "s1"]);
    expect(stmts[2]!.sql).toMatch(/UPDATE swimlanes SET archived_at = \? WHERE id = \?/);
    expect(stmts[2]!.sql).not.toMatch(/updated_at/);
  });

  it("milestone: constant 4 statements — sprint-scoped task work + milestone update", () => {
    const stmts = buildMilestoneArchiveBatch({ milestoneId: "m1", archivedAt: "2026-08-25T10:00:00Z", actor: { ...actor, message: "Maria archived this task", viaAssistant: true } });
    expect(stmts).toHaveLength(4);
    expect(stmts[0]!.sql).toMatch(/swimlane_id IN \(SELECT id FROM swimlanes WHERE milestone_id = \?\)/);
    expect(stmts[0]!.params[4]).toBe(1);
    expect(stmts[1]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\)/);
    expect(stmts[2]!.sql).toMatch(/UPDATE swimlanes SET archived_at = \? WHERE milestone_id = \?/);
    expect(stmts[2]!.sql).not.toMatch(/updated_at/);
    expect(stmts[3]!.sql).toMatch(/UPDATE milestones SET archived_at = \?, updated_at = datetime\('now'\)/);
  });

  it("executes on a real schema shape: one activity row per live task, in position order", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE milestones (id TEXT PRIMARY KEY, archived_at TEXT, updated_at TEXT);
        CREATE TABLE swimlanes (id TEXT PRIMARY KEY, milestone_id TEXT, archived_at TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, swimlane_id TEXT, position TEXT, archived_at TEXT, updated_at TEXT);
        CREATE TABLE task_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor_kind TEXT, actor_label TEXT, actor_user_id TEXT, type TEXT, message TEXT, via_assistant INTEGER, created_at TEXT DEFAULT (datetime('now')));
      `);
      db.exec(`INSERT INTO swimlanes (id, milestone_id) VALUES ('s1','m1')`);
      db.exec(`INSERT INTO tasks (id, swimlane_id, position) VALUES ('t2','s1','a1'), ('t1','s1','a0'), ('t3','s1','a2')`);
      db.exec(`INSERT INTO tasks (id, swimlane_id, position, archived_at) VALUES ('t-arch','s1','a3','2026-01-01 00:00:00')`);

      const stmts = buildSwimlaneArchiveBatch({ swimlaneId: "s1", archivedAt: "2026-08-25T10:00:00Z", actor });
      db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();

      const activity = db.query("SELECT task_id FROM task_activity ORDER BY id").all() as { task_id: string }[];
      expect(activity.map((a) => a.task_id)).toEqual(["t1", "t2", "t3"]);
      const live = db.query("SELECT COUNT(*) n FROM tasks WHERE swimlane_id = 's1' AND archived_at IS NULL").get() as { n: number };
      expect(live.n).toBe(0);
      const arch = db.query("SELECT archived_at FROM tasks WHERE id = 't-arch'").get() as { archived_at: string };
      expect(arch.archived_at).toBe("2026-01-01 00:00:00");
      const lane = db.query("SELECT archived_at FROM swimlanes WHERE id = 's1'").get() as { archived_at: string };
      expect(lane.archived_at).toBe("2026-08-25T10:00:00Z");
    } finally {
      db.close();
    }
  });
});

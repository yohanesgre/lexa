import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { buildSwimlaneArchiveBatch, buildMilestoneArchiveBatch, buildSwimlaneRestoreBatch, buildMilestoneRestoreBatch } from "./cascade-batch";
import type { BatchStmt } from "./task-batch";

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
    expect(stmts[2]!.sql).toMatch(/UPDATE swimlanes SET archived_at = \? WHERE milestone_id = \? AND archived_at IS NULL/);
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

  it("swimlane restore: constant 3 statements — activity scoped to the archive stamp, task + lane restore", () => {
    const stmts = buildSwimlaneRestoreBatch({ swimlaneId: "s1", swimlaneArchivedAt: "2026-08-25T10:00:00Z", actor: { ...actor, message: "Maria restored this task" } });
    expect(stmts).toHaveLength(3);
    expect(stmts[0]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[0]!.sql).toMatch(/SELECT id, \?, \?, \?, 'restored', \?, \?/);
    expect(stmts[0]!.sql).toMatch(/swimlane_id = \? AND archived_at = \?/);
    expect(stmts[0]!.sql).toMatch(/RETURNING id, task_id/);
    expect(stmts[0]!.params).toEqual(["user", "Maria", "u1", "Maria restored this task", 0, "s1", "2026-08-25T10:00:00Z"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE tasks SET archived_at = NULL, updated_at = datetime\('now'\)/);
    expect(stmts[1]!.params).toEqual(["s1", "2026-08-25T10:00:00Z"]);
    expect(stmts[2]!.sql).toMatch(/UPDATE swimlanes SET archived_at = NULL WHERE id = \? AND archived_at = \?/);
    expect(stmts[2]!.params).toEqual(["s1", "2026-08-25T10:00:00Z"]);
  });

  it("milestone restore: constant 4 statements — sprint-scoped task work + milestone restore", () => {
    const stmts = buildMilestoneRestoreBatch({ milestoneId: "m1", milestoneArchivedAt: "2026-08-25T10:00:00Z", actor: { ...actor, message: "Maria restored this task" } });
    expect(stmts).toHaveLength(4);
    expect(stmts[0]!.sql).toMatch(/swimlane_id IN \(SELECT id FROM swimlanes WHERE milestone_id = \?\)/);
    expect(stmts[0]!.sql).toMatch(/archived_at = \? AND swimlane_id IN/);
    expect(stmts[0]!.params).toEqual(["user", "Maria", "u1", "Maria restored this task", 0, "2026-08-25T10:00:00Z", "m1"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE tasks SET archived_at = NULL, updated_at = datetime\('now'\)/);
    expect(stmts[2]!.sql).toMatch(/UPDATE swimlanes SET archived_at = NULL WHERE milestone_id = \? AND archived_at = \?/);
    expect(stmts[3]!.sql).toMatch(/UPDATE milestones SET archived_at = NULL, updated_at = datetime\('now'\) WHERE id = \? AND archived_at = \?/);
  });

  it("swimlane restore executes: cascaded tasks return, individually-archived (older stamp) stays archived", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE swimlanes (id TEXT PRIMARY KEY, milestone_id TEXT, archived_at TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, swimlane_id TEXT, position TEXT, archived_at TEXT, updated_at TEXT);
        CREATE TABLE task_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor_kind TEXT, actor_label TEXT, actor_user_id TEXT, type TEXT, message TEXT, via_assistant INTEGER, created_at TEXT DEFAULT (datetime('now')));
      `);
      db.exec(`INSERT INTO swimlanes (id, archived_at) VALUES ('s1','2026-08-25T10:00:00Z')`);
      db.exec(`INSERT INTO tasks (id, swimlane_id, position, archived_at) VALUES ('t2','s1','a1','2026-08-25T10:00:00Z'), ('t1','s1','a0','2026-08-25T10:00:00Z')`);
      db.exec(`INSERT INTO tasks (id, swimlane_id, position, archived_at) VALUES ('t-old','s1','a2','2026-01-01 00:00:00')`);

      const stmts = buildSwimlaneRestoreBatch({ swimlaneId: "s1", swimlaneArchivedAt: "2026-08-25T10:00:00Z", actor: { ...actor, message: "Maria restored this task" } });
      db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();

      const activity = db.query("SELECT task_id, type FROM task_activity ORDER BY id").all() as { task_id: string; type: string }[];
      expect(activity).toEqual([{ task_id: "t1", type: "restored" }, { task_id: "t2", type: "restored" }]);
      const live = db.query("SELECT COUNT(*) n FROM tasks WHERE swimlane_id = 's1' AND archived_at IS NULL").get() as { n: number };
      expect(live.n).toBe(2);
      const old = db.query("SELECT archived_at FROM tasks WHERE id = 't-old'").get() as { archived_at: string };
      expect(old.archived_at).toBe("2026-01-01 00:00:00");
      const lane = db.query("SELECT archived_at FROM swimlanes WHERE id = 's1'").get() as { archived_at: string | null };
      expect(lane.archived_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("archive→archive→restore sequence: an individually-archived sprint keeps its older stamp through the milestone archive; the milestone restore leaves it, then the sprint restore cascades its own tasks", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE milestones (id TEXT PRIMARY KEY, archived_at TEXT, updated_at TEXT);
        CREATE TABLE swimlanes (id TEXT PRIMARY KEY, milestone_id TEXT, archived_at TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, swimlane_id TEXT, position TEXT, archived_at TEXT, updated_at TEXT);
        CREATE TABLE task_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor_kind TEXT, actor_label TEXT, actor_user_id TEXT, type TEXT, message TEXT, via_assistant INTEGER, created_at TEXT DEFAULT (datetime('now')));
      `);
      db.exec(`INSERT INTO milestones (id) VALUES ('m1')`);
      db.exec(`INSERT INTO swimlanes (id, milestone_id) VALUES ('s-live','m1'), ('s-old','m1')`);
      db.exec(`INSERT INTO tasks (id, swimlane_id, position) VALUES ('t-live','s-live','a0'), ('t-old','s-old','a0')`);

      const T1 = "2026-01-01T00:00:00Z";
      const T2 = "2026-08-25T10:00:00Z";
      const run = (stmts: BatchStmt[]) => db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();
      const stamp = (id: string) => (db.query(`SELECT archived_at FROM swimlanes WHERE id = '${id}'`).get() as { archived_at: string | null }).archived_at;
      const taskStamp = (id: string) => (db.query(`SELECT archived_at FROM tasks WHERE id = '${id}'`).get() as { archived_at: string | null }).archived_at;
      const restoredIds = () => (db.query("SELECT task_id FROM task_activity WHERE type = 'restored' ORDER BY id").all() as { task_id: string }[]).map((r) => r.task_id);

      // T1: archive s-old individually → its task takes T1.
      run(buildSwimlaneArchiveBatch({ swimlaneId: "s-old", archivedAt: T1, actor }));
      // T2: archive the milestone → the individually-archived s-old is skipped (!archived_at IS NULL guards the sprint UPDATE); s-live takes T2.
      run(buildMilestoneArchiveBatch({ milestoneId: "m1", archivedAt: T2, actor: { ...actor, message: "Maria archived this task", viaAssistant: true } }));

      expect(stamp("s-old")).toBe(T1);
      expect(stamp("s-live")).toBe(T2);
      expect(taskStamp("t-old")).toBe(T1);
      expect(taskStamp("t-live")).toBe(T2);

      // Restore the milestone (T2 stamp): only T2-stamped children return; a
      // second pass is a no-op (no duplicate activity).
      const milestoneRestore = buildMilestoneRestoreBatch({ milestoneId: "m1", milestoneArchivedAt: T2, actor: { ...actor, message: "Maria restored this task" } });
      run(milestoneRestore);
      run(milestoneRestore);

      expect(restoredIds()).toEqual(["t-live"]);
      expect(stamp("s-old")).toBe(T1);
      expect(taskStamp("t-old")).toBe(T1);
      expect(stamp("s-live")).toBeNull();
      expect(taskStamp("t-live")).toBeNull();
      expect((db.query("SELECT archived_at FROM milestones WHERE id = 'm1'").get() as { archived_at: string | null }).archived_at).toBeNull();

      // Restoring the individually-archived sprint cascades its T1-stamped task.
      run(buildSwimlaneRestoreBatch({ swimlaneId: "s-old", swimlaneArchivedAt: T1, actor: { ...actor, message: "Maria restored this task" } }));
      expect(stamp("s-old")).toBeNull();
      expect(taskStamp("t-old")).toBeNull();
      expect(restoredIds()).toEqual(["t-live", "t-old"]);
    } finally {
      db.close();
    }
  });
});

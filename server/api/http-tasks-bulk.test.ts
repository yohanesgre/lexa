import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { keyAfter } from "../../shared/positions";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-tasks-bulk-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1000);
INSERT INTO columns (id, project_id, name, position) VALUES
  ('c1', 'p1', 'Todo', 0),
  ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES
  ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES
  ('m1', 'p1', 'Sprint 1', 1, 'sprint', '2026-06-01');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES
  ('prio-1', 'p1', 'Medium', '#888', 0),
  ('prio-2', 'p1', 'High', '#f00', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES
  ('type-1', 'p1', 'Bug', '#f00', 0),
  ('type-2', 'p1', 'Feature', '#0f0', 1);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

let seq = 0;
function addTask(columnId: string, opts?: { swimlaneId?: string; assignees?: string[]; title?: string }): string {
  const n = ++seq;
  const id = `bt-${n}`;
  const key = `EG-${100 + n}`;
  // Anchor to the column's real max: a bulk move REPOSITIONS the task (append
  // to column end), so a local running anchor drifts behind service writes.
  const lastPos = (db.prepare("SELECT MAX(position) m FROM tasks WHERE column_id = ?").get(columnId) as { m: string | null }).m;
  const position = keyAfter(lastPos);
  db.prepare(
    `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at)
     VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, '2026-01-01 10:00:00')`
  ).run(id, columnId, opts?.swimlaneId ?? "s-backlog", opts?.title ?? `Task ${n}`, position, key, 100 + n);
  for (const a of opts?.assignees ?? []) {
    db.prepare("INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)").run(id, a);
  }
  return id;
}

const activityCount = (id: string, type: string): number =>
  (db.prepare("SELECT COUNT(*) c FROM task_activity WHERE task_id = ? AND type = ?").get(id, type) as { c: number }).c;

const bulk = (body: unknown) => json("POST", "/api/projects/p1/tasks/bulk", body);

describe("bulk task actions — update", () => {
  it("applies the update to every id and emits one activity row per task", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await handler(bulk({ ids: [a, b], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ applied: [a, b], failed: [] });
    for (const id of [a, b]) {
      expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(id) as { priority: string }).priority).toBe("prio-2");
      expect(activityCount(id, "field_changed")).toBe(1);
    }
  });

  it("reports unknown ids per task while the rest apply", async () => {
    const a = addTask("c1");
    const res = await handler(bulk({ ids: [a, "nope"], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a]);
    expect(body.failed).toEqual([{ id: "nope", code: "TASK_NOT_FOUND", message: "Task not found" }]);
    expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string }).priority).toBe("prio-2");
  });

  it("a per-item failure does not roll back items applied before or after it (no request-level transaction)", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await handler(bulk({ ids: ["nope", a, b], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a, b]);
    expect(body.failed).toEqual([{ id: "nope", code: "TASK_NOT_FOUND", message: "Task not found" }]);
    for (const id of [a, b]) {
      expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(id) as { priority: string }).priority).toBe("prio-2");
      expect(activityCount(id, "field_changed")).toBe(1);
    }
  });

  it("resolves the PREFIX-n ticket-key alias in ids", async () => {
    const a = addTask("c1");
    const key = (db.prepare("SELECT key FROM tasks WHERE id = ?").get(a) as { key: string }).key;
    const res = await handler(bulk({ ids: [key], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a]);
    expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string }).priority).toBe("prio-2");
  });
});

describe("bulk task actions — move", () => {
  it("collects WIP-limit rejections while the permitted tasks still apply", async () => {
    db.prepare("INSERT INTO columns (id, project_id, name, position, wip_limit) VALUES ('c-wip', 'p1', 'Wip', 5, 2)").run();
    addTask("c-wip", { title: "Filler" });
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await handler(bulk({ ids: [a, b], action: "move", columnId: "c-wip" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe(b);
    expect(body.failed[0].code).toBe("WIP_LIMIT");
    expect(body.failed[0].message).toContain("Wip");
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string }).column_id).toBe("c-wip");
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(b) as { column_id: string }).column_id).toBe("c1");
    expect(activityCount(a, "moved")).toBe(1);
  });

  it("collects required_fields rejections while the permitted tasks still apply", async () => {
    db.prepare("INSERT INTO columns (id, project_id, name, position, required_fields) VALUES ('c-req', 'p1', 'Req', 6, '[\"assignee\"]')").run();
    const ok = addTask("c1", { assignees: ["Maria"] });
    const no = addTask("c1");
    const res = await handler(bulk({ ids: [ok, no], action: "move", columnId: "c-req" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([ok]);
    expect(body.failed).toEqual([{ id: no, code: "REQUIRED_FIELD", message: "Field 'assignee' is required in column 'Req'" }]);
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(ok) as { column_id: string }).column_id).toBe("c-req");
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(no) as { column_id: string }).column_id).toBe("c1");
  });

  it("keeps the current column when only a swimlane is given; rejects a targetless move with no writes", async () => {
    const a = addTask("c1");
    const moved = await handler(bulk({ ids: [a], action: "move", swimlaneId: "m1" }));
    // The task's deadline is null, so the sprint deadline does not block it.
    expect(moved.status).toBe(200);
    expect((await moved.json()).applied).toEqual([a]);
    expect((db.prepare("SELECT swimlane_id FROM tasks WHERE id = ?").get(a) as { swimlane_id: string }).swimlane_id).toBe("m1");
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string }).column_id).toBe("c1");

    const rejected = await handler(bulk({ ids: [a], action: "move" }));
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error.code).toBe("INVALID_ARGS");
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string }).column_id).toBe("c1");
  });
});

describe("bulk task actions — archive / restore", () => {
  it("archives and restores, keeping the position, and emits rows", async () => {
    const a = addTask("c1");
    const before = db.prepare("SELECT position FROM tasks WHERE id = ?").get(a) as { position: string };
    const archived = await handler(bulk({ ids: [a], action: "archive" }));
    expect(archived.status).toBe(200);
    expect((await archived.json()).applied).toEqual([a]);
    const row = db.prepare("SELECT archived_at, position FROM tasks WHERE id = ?").get(a) as { archived_at: string | null; position: string };
    expect(row.archived_at).not.toBeNull();
    expect(row.position).toBe(before.position);
    expect(activityCount(a, "archived")).toBe(1);

    const restored = await handler(bulk({ ids: [a], action: "restore" }));
    expect(restored.status).toBe(200);
    expect((await restored.json()).applied).toEqual([a]);
    expect((db.prepare("SELECT archived_at FROM tasks WHERE id = ?").get(a) as { archived_at: string | null }).archived_at).toBeNull();
    expect(activityCount(a, "restored")).toBe(1);
  });

  it("is idempotent — re-archiving an archived task applies without a second row", async () => {
    const a = addTask("c1");
    await handler(bulk({ ids: [a], action: "archive" }));
    const again = await handler(bulk({ ids: [a], action: "archive" }));
    expect(again.status).toBe(200);
    expect((await again.json()).applied).toEqual([a]);
    expect(activityCount(a, "archived")).toBe(1);
  });
});

describe("bulk task actions — kill switch (LXK_DISABLE_TASKS_BULK=1)", () => {
  it("refuses with 403 TASKS_BULK_DISABLED and changes no task", async () => {
    const a = addTask("c1");
    process.env.LXK_DISABLE_TASKS_BULK = "1";
    try {
      const res = await handler(bulk({ ids: [a], action: "update", priority: "prio-2" }));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("TASKS_BULK_DISABLED");
      expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string }).priority).not.toBe("prio-2");
      expect(activityCount(a, "field_changed")).toBe(0);
    } finally {
      delete process.env.LXK_DISABLE_TASKS_BULK;
    }
  });
});

describe("bulk task actions — 100-id smoke", () => {
  it("applies a 100-task bulk action in one request", async () => {
    const ids = Array.from({ length: 100 }, () => addTask("c2"));
    const res = await handler(bulk({ ids, action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toEqual([]);
    expect(body.applied).toHaveLength(100);
    const changed = db.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE id IN (${ids.map(() => "?").join(",")}) AND priority = 'prio-2'`
    ).get(...ids) as { c: number };
    expect(changed.c).toBe(100);
  });

  it("refuses more than 100 ids with 422 INVALID_ARGS and writes nothing", async () => {
    const ids = Array.from({ length: 101 }, () => addTask("c2"));
    const res = await handler(bulk({ ids, action: "update", priority: "prio-2" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
    const changed = db.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE id IN (${ids.map(() => "?").join(",")}) AND priority = 'prio-2'`
    ).get(...ids) as { c: number };
    expect(changed.c).toBe(0);
  });
});

describe("bulk task actions — de-dupe", () => {
  it("de-dupes repeated ids first-seen so applied never echoes a duplicate", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await handler(bulk({ ids: [a, b, a], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a, b]);
    expect(activityCount(a, "field_changed")).toBe(1);
    expect(activityCount(b, "field_changed")).toBe(1);
  });
});

describe("bulk task actions — project isolation", () => {
  it("rejects an id from another project per task without touching it", async () => {
    db.exec(`
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p2', 'P2', 'p2', 'EG2', 2000);
INSERT INTO columns (id, project_id, name, position) VALUES ('p2c1', 'p2', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('p2s', 'p2', 'Backlog', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at)
  VALUES ('other-task', 'p2', 'p2c1', 'p2s', 'Other', 'a0', 'EG2-1', 1, '2026-01-01 10:00:00');
`);
    const before = db.prepare("SELECT priority FROM tasks WHERE id = 'other-task'").get() as { priority: string | null };
    const a = addTask("c1");
    const res = await handler(bulk({ ids: [a, "other-task"], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a]);
    expect(body.failed).toEqual([{ id: "other-task", code: "TASK_NOT_FOUND", message: "Task not found" }]);
    expect((db.prepare("SELECT priority FROM tasks WHERE id = 'other-task'").get() as { priority: string | null }).priority).toBe(before.priority);
  });
});

describe("bulk task actions — rejections write nothing", () => {
  it("collects INVALID_OPTION and leaves the rejected row and updated_at untouched", async () => {
    const a = addTask("c1");
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a);
    const before = db.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string | null };
    const res = await handler(bulk({ ids: [a], action: "update", priority: "bogus" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([]);
    expect(body.failed).toEqual([{ id: a, code: "INVALID_OPTION", message: "unknown priority option for this project" }]);
    const row = db.prepare("SELECT priority, updated_at FROM tasks WHERE id = ?").get(a) as { priority: string | null; updated_at: string };
    expect(row.priority).toBe(before.priority);
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
    expect(activityCount(a, "field_changed")).toBe(0);
  });

  it("collects COLUMN_NOT_FOUND when the target column does not exist", async () => {
    const a = addTask("c1");
    const res = await handler(bulk({ ids: [a], action: "move", columnId: "nope-col" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([]);
    expect(body.failed).toEqual([{ id: a, code: "COLUMN_NOT_FOUND", message: "Column not found" }]);
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string }).column_id).toBe("c1");
  });

  it("collects a WIP rejection without moving the rejected task", async () => {
    db.prepare("INSERT INTO columns (id, project_id, name, position, wip_limit) VALUES ('c-wip2', 'p1', 'Wip2', 7, 1)").run();
    addTask("c-wip2", { title: "Filler2" });
    const a = addTask("c1");
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a);
    const res = await handler(bulk({ ids: [a], action: "move", columnId: "c-wip2" }));
    expect(res.status).toBe(200);
    expect((await res.json()).failed).toEqual([{ id: a, code: "WIP_LIMIT", message: "Column 'Wip2' is at its WIP limit of 1" }]);
    const row = db.prepare("SELECT column_id, updated_at FROM tasks WHERE id = ?").get(a) as { column_id: string; updated_at: string };
    expect(row.column_id).toBe("c1");
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
  });
});

describe("bulk task actions — infrastructure failure mid-loop", () => {
  it("propagates a DbError while items already committed stay applied", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    // Force a deterministic infrastructure failure on the SECOND item: its
    // activity insert aborts the item's atomic batch. The first item's batch
    // has already committed and must survive the mid-loop abort.
    db.exec(`CREATE TRIGGER block_bulk_activity BEFORE INSERT ON task_activity
             WHEN NEW.task_id = '${b}'
             BEGIN SELECT RAISE(ABORT, 'blocked bulk'); END`);
    try {
      const res = await handler(bulk({ ids: [a, b], action: "update", priority: "prio-2" }));
      expect(res.status).toBe(500);
      expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string | null }).priority).toBe("prio-2");
      expect(activityCount(a, "field_changed")).toBe(1);
      // The failed item rolled back entirely — no partial write.
      expect((db.prepare("SELECT priority FROM tasks WHERE id = ?").get(b) as { priority: string | null }).priority).not.toBe("prio-2");
      expect(activityCount(b, "field_changed")).toBe(0);
    } finally {
      db.exec("DROP TRIGGER block_bulk_activity");
    }
  });
});

describe("bulk task actions — update fields", () => {
  it("applies assignees, type, and dueAt and advances updated_at", async () => {
    const a = addTask("c1");
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a);
    const res = await handler(bulk({ ids: [a], action: "update", assignees: ["Maria", "Jo"], type: "type-2", dueAt: "2026-05-01" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a]);
    const row = db.prepare("SELECT type, due_at, updated_at FROM tasks WHERE id = ?").get(a) as { type: string; due_at: string | null; updated_at: string };
    expect(row.type).toBe("type-2");
    expect(row.due_at).toBe("2026-05-01");
    expect(row.updated_at).not.toBe("2020-01-01 00:00:00");
    const assignees = (db.prepare("SELECT user_name FROM task_assignees WHERE task_id = ? ORDER BY user_name").all(a) as { user_name: string }[]).map((r) => r.user_name);
    expect(assignees).toEqual(["Jo", "Maria"]);
  });
});

describe("bulk task actions — GitHub sync parity", () => {
  it("runs the route-level content sync for a linked task on bulk update", async () => {
    const a = addTask("c1");
    db.prepare(
      "INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES (?, 'ghi-bulk', 42, 'owner/repo', 'open')"
    ).run(a);
    const res = await handler(bulk({ ids: [a], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a]);
    // The stale pushed_* makes syncContentFromLexa attempt a push; without a
    // configured GitHub App it fails and records push_failed — proving the
    // route (not the service) invoked the content sync.
    const link = db.prepare(
      "SELECT push_failed FROM task_github_issues WHERE task_id = ? AND issue_id = 'ghi-bulk'"
    ).get(a) as { push_failed: number };
    expect(link.push_failed).toBe(1);
  });

  it("best-effort state sync on a bulk move to a mapped column never fails the request", async () => {
    db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-gh', 'p1', 'GH', 8, 'closed')").run();
    const a = addTask("c1");
    db.prepare(
      "INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES (?, 'ghi-move', 43, 'owner/repo', 'open')"
    ).run(a);
    const res = await handler(bulk({ ids: [a], action: "move", columnId: "c-gh" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a]);
    const row = db.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string };
    expect(row.column_id).toBe("c-gh");
    // State push failed (no App configured) but was swallowed; synced_state
    // stays as it was and the move already committed.
    const link = db.prepare(
      "SELECT synced_state FROM task_github_issues WHERE task_id = ? AND issue_id = 'ghi-move'"
    ).get(a) as { synced_state: string | null };
    expect(link.synced_state).toBe("open");
  });
});

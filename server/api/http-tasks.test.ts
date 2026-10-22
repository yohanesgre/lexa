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
  dir = mkdtempSync(join(tmpdir(), "lexa-tasks-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 2);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1', 'p1', 'Milestone 1', 1, 'sprint', '2026-06-01');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0), ('prio-2', 'p1', 'High', '#f00', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Bug', '#f00', 0), ('type-2', 'p1', 'Feature', '#0f0', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at, key, number) VALUES ('t1', 'p1', 'c1', 'm1', 'T1', 'a0', '2026-06-15', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2', 'p1', 'c2', 's-backlog', 'T2', 'a0', '2026-01-01 10:00:00', 'EG-2', 2);
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

describe("task create routes", () => {
  it("POST creates a task with defaults (201); an unknown column → 404 COLUMN_NOT_FOUND", async () => {
    const res = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c1", title: "New" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("New");
    expect(body.data.priority).toBe("prio-1");
    expect(body.data.description).toBe("");

    const bad = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "nope", title: "X" }));
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe("COLUMN_NOT_FOUND");
  });
  it("rejects legacy object descriptions before writing task or activity rows", async () => {
    const taskCount = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'p1'").get() as { n: number }).n;
    const activityCount = (db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n;
    const description = (db.prepare("SELECT description FROM tasks WHERE id = 't1'").get() as { description: string }).description;
    const legacy = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old form" }] }] };
    const create = await handler(json("POST", "/api/projects/p1/tasks", {
      columnId: "c1",
      title: "Legacy payload",
      description: legacy,
    }));
    expect(create.status).toBeGreaterThanOrEqual(400);
    const update = await handler(json("PATCH", "/api/projects/p1/tasks/t1", { description: legacy }));
    expect(update.status).toBeGreaterThanOrEqual(400);
    expect((db.prepare("SELECT description FROM tasks WHERE id = 't1'").get() as { description: string }).description).toBe(description);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'p1'").get() as { n: number }).n).toBe(taskCount);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(activityCount);
  });
  it("returns committed Markdown when an unrelated malformed destination cannot be expanded for GitHub", async () => {
    const created = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c1", title: "URL boundary" }));
    expect(created.status).toBe(201);
    const task = (await created.json()).data as { id: string };
    const source = "# Boundary\n\n[bad](//)\n";
    try {
      db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES (?, ?, ?, ?, ?)")
        .run(task.id, "ghi-url-boundary", 7, "owner/repo", "open");
      const response = await handler(json("PATCH", `/api/projects/p1/tasks/${task.id}`, { description: source }));
      expect(response.status).toBe(200);
      expect((await response.json()).data.description).toBe(source);
      expect(db.prepare("SELECT description FROM tasks WHERE id = ?").get(task.id)).toEqual({ description: source });
      expect(db.prepare("SELECT push_failed FROM task_github_issues WHERE issue_id = ?").get("ghi-url-boundary"))
        .toEqual({ push_failed: 1 });
    } finally {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    }
  });

  it("POST into a column that requires assignee without one → 422 REQUIRED_FIELD", async () => {
    db.prepare("UPDATE columns SET required_fields = '[\"assignee\"]' WHERE id = 'c2'").run();
    const res = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c2", title: "No assignee" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("REQUIRED_FIELD");
    expect(body.error.details.field).toBe("assignee");
    const ok = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c2", title: "Has assignee", assignees: ["Maria"] }));
    expect(ok.status).toBe(201);
  });
});

describe("task move routes", () => {
  it("move enforces WIP limit, position conflict, and lane deadline (clearDueAt bypasses)", async () => {
    // #5 WIP_LIMIT with details
    const created = await handler(json("POST", "/api/projects/p1/columns", { name: "Wip", wipLimit: 1 }));
    const { id } = await created.json();
    await handler(json("POST", "/api/projects/p1/tasks", { columnId: id, title: "Filler" }));
    const wip = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: id, swimlaneId: "s-backlog" }));
    expect(wip.status).toBe(409);
    const wipBody = await wip.json();
    expect(wipBody.error.code).toBe("WIP_LIMIT");
    expect(wipBody.error.details).toMatchObject({ column: "Wip", limit: 1, current: 1 });

    // #4 position conflict
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c-cf', 'p1', 'Conflict', 9)").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d1','p1','c-cf','s-backlog','D1','a1','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d2','p1','c-cf','s-backlog','D2','a1V','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d3','p1','c-cf','s-backlog','D3','a2','2026-01-01 10:00:00')").run();
    const conflict = await handler(json("POST", "/api/projects/p1/tasks/t1/move", {
      columnId: "c-cf", swimlaneId: "s-backlog", afterTaskId: "d1", beforeTaskId: "d3",
    }));
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.error.code).toBe("CONSTRAINT");
    expect(conflictBody.error.details.isPositionConflict).toBe(true);

    // deadline + clearDueAt bypass
    const blocked = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: "c1", swimlaneId: "m1" }));
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.code).toBe("DEADLINE_AFTER_LANE");
    expect(blockedBody.error.details.date).toBe("2026-06-01");
    const cleared = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: "c1", swimlaneId: "m1", clearDueAt: true }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.dueAt).toBeNull();
  });
});

describe("task ticket key routes", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p-key', 'Key', 'p-key', 'EMB')").run();
    db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p-key2', 'Key2', 'p-key2', 'WC')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('ck1', 'p-key', 'Todo', 0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('sk', 'p-key', 'Backlog', 0, 'backlog')").run();
    db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('pk-prio', 'p-key', 'Medium', '#888', 0)").run();
    db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('pk-type', 'p-key', 'Bug', '#f00', 0)").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at) VALUES ('tk1', 'p-key', 'ck1', 'sk', 'Key Task', 'a0', 'EMB-1', 1, '2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at) VALUES ('tk2', 'p-key', 'ck1', 'sk', 'Key Task 2', 'a1', 'EMB-2', 2, '2026-01-01 10:00:00')").run();
    db.prepare("UPDATE projects SET next_task_number = 3 WHERE id = 'p-key'").run();
  });

  it("ticket keys resolve across GET, subtask links, task links, search exclude, move anchors, and document sources", async () => {
    // GET by key
    const get = await handler(json("GET", "/api/projects/p-key/tasks/EMB-1"));
    expect(get.status).toBe(200);
    expect((await get.json()).key).toBe("EMB-1");

    // parentId resolves to a subtask_of link
    const sub = await handler(json("POST", "/api/projects/p-key/tasks", { columnId: "ck1", title: "Sub of EMB-1", parentId: "EMB-1" }));
    expect(sub.status).toBe(201);
    const created = await sub.json();
    const links = await handler(json("GET", `/api/projects/p-key/tasks/${created.data.id}/links`));
    expect(links.status).toBe(200);
    expect((await links.json()).data).toEqual([expect.objectContaining({ toTaskId: "tk1", relation: "subtask_of" })]);

    // POST link with a ticket-key toTaskId resolves to the target UUID
    const link = await handler(json("POST", "/api/projects/p-key/tasks/EMB-2/links", { toTaskId: "EMB-1", relation: "related_to" }));
    expect(link.status).toBe(201);
    const linkBody = await link.json();
    expect(linkBody.data.toTaskId).toBe("tk1");
    expect(linkBody.data.fromTaskId).toBe("tk2");

    // search exclude accepts a ticket key and filters that task
    const search = await handler(json("GET", "/api/projects/p-key/tasks/search?q=Key&exclude=EMB-1"));
    expect(search.status).toBe(200);
    const ids = ((await search.json()).data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain("tk1");
    expect(ids).toContain("tk2");
    // an unresolvable exclude key is treated as no exclusions
    const searchBad = await handler(json("GET", "/api/projects/p-key/tasks/search?q=Key&exclude=EMB-999"));
    expect(searchBad.status).toBe(200);
    const idsBad = ((await searchBad.json()).data as Array<{ id: string }>).map((t) => t.id);
    expect(idsBad).toContain("tk1");
    expect(idsBad).toContain("tk2");

    // move accepts ticket-key anchors
    const move = await handler(json("POST", "/api/projects/p-key/tasks/EMB-2/move", { columnId: "ck1", swimlaneId: "sk", afterTaskId: "EMB-1" }));
    expect(move.status).toBe(200);
    expect((await move.json()).data.id).toBe("tk2");

    // document sources accept a ticket-key task id
    const add = await handler(json("POST", "/api/projects/p1/documents/task/EG-1/sources", { kind: "external", ref: "https://example.com/eg" }));
    expect(add.status).toBe(201);
    expect((await add.json()).data.documentId).toBe("t1");
    const list = await handler(json("GET", "/api/projects/p1/documents/task/EG-1/sources"));
    expect(list.status).toBe(200);
    expect(((await list.json()).data as Array<{ documentId: string }>).map((s) => s.documentId)).toContain("t1");
  });

  it("move with an unresolvable key anchor is a 404, not a 500", async () => {
    const res = await handler(json("POST", "/api/projects/p-key/tasks/EMB-2/move", { columnId: "ck1", swimlaneId: "sk", afterTaskId: "EMB-999" }));
    expect(res.status).toBe(404);
  });
});

describe("bulk task actions", () => {
  let bulkDir: string;
  let bulkHandler: (req: Request) => Promise<Response>;
  let bulkDb: Database;

  beforeAll(async () => {
    bulkDir = mkdtempSync(join(tmpdir(), "lexa-tasks-bulk-"));
    const dbPath = join(bulkDir, "test.db");
    runMigrations(dbPath, MIGRATIONS);
    const adminHash = await sha256(ADMIN_KEY);
    bulkDb = new Database(dbPath);
    bulkDb.exec(`
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
    bulkHandler = createApiHandler(dbPath);
  });

  afterAll(() => {
    try { bulkDb.close(); } catch {}
    rmSync(bulkDir, { recursive: true, force: true });
  });

  let seq = 0;
  function addTask(columnId: string, opts?: { swimlaneId?: string; assignees?: string[]; title?: string }): string {
    const n = ++seq;
    const id = `bt-${n}`;
    const key = `EG-${100 + n}`;
    // Anchor to the column's real max: a bulk move REPOSITIONS the task (append
    // to column end), so a local running anchor drifts behind service writes.
    const lastPos = (bulkDb.prepare("SELECT MAX(position) m FROM tasks WHERE column_id = ?").get(columnId) as { m: string | null }).m;
    const position = keyAfter(lastPos);
    bulkDb.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at)
       VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, '2026-01-01 10:00:00')`
    ).run(id, columnId, opts?.swimlaneId ?? "s-backlog", opts?.title ?? `Task ${n}`, position, key, 100 + n);
    for (const a of opts?.assignees ?? []) {
      bulkDb.prepare("INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)").run(id, a);
    }
    return id;
  }

  const activityCount = (id: string, type: string): number =>
    (bulkDb.prepare("SELECT COUNT(*) c FROM task_activity WHERE task_id = ? AND type = ?").get(id, type) as { c: number }).c;

  const bulk = (body: unknown) => json("POST", "/api/projects/p1/tasks/bulk", body);

  it("applies the update to every id and emits one activity row per applied task", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await bulkHandler(bulk({ ids: [a, b], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ applied: [a, b], failed: [] });
    for (const id of [a, b]) {
      expect((bulkDb.prepare("SELECT priority FROM tasks WHERE id = ?").get(id) as { priority: string }).priority).toBe("prio-2");
      expect(activityCount(id, "field_changed")).toBe(1);
    }
  });

  it("a per-item failure does not roll back items applied before or after it (no request-level transaction)", async () => {
    const a = addTask("c1");
    const b = addTask("c1");
    const res = await bulkHandler(bulk({ ids: ["nope", a, b], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a, b]);
    expect(body.failed).toEqual([{ id: "nope", code: "TASK_NOT_FOUND", message: "Task not found" }]);
    for (const id of [a, b]) {
      expect((bulkDb.prepare("SELECT priority FROM tasks WHERE id = ?").get(id) as { priority: string }).priority).toBe("prio-2");
      expect(activityCount(id, "field_changed")).toBe(1);
    }
  });

  it("collects per-id WIP-limit and required_fields rejections while permitted tasks still apply", async () => {
    // WIP limit
    bulkDb.prepare("INSERT INTO columns (id, project_id, name, position, wip_limit) VALUES ('c-wip', 'p1', 'Wip', 5, 2)").run();
    addTask("c-wip", { title: "Filler" });
    const wipA = addTask("c1");
    const wipB = addTask("c1");
    const wipRes = await bulkHandler(bulk({ ids: [wipA, wipB], action: "move", columnId: "c-wip" }));
    expect(wipRes.status).toBe(200);
    const wipBody = await wipRes.json();
    expect(wipBody.applied).toEqual([wipA]);
    expect(wipBody.failed).toHaveLength(1);
    expect(wipBody.failed[0].id).toBe(wipB);
    expect(wipBody.failed[0].code).toBe("WIP_LIMIT");
    expect(wipBody.failed[0].message).toContain("Wip");
    expect((bulkDb.prepare("SELECT column_id FROM tasks WHERE id = ?").get(wipA) as { column_id: string }).column_id).toBe("c-wip");
    expect((bulkDb.prepare("SELECT column_id FROM tasks WHERE id = ?").get(wipB) as { column_id: string }).column_id).toBe("c1");
    expect(activityCount(wipA, "moved")).toBe(1);

    // required_fields
    bulkDb.prepare("INSERT INTO columns (id, project_id, name, position, required_fields) VALUES ('c-req', 'p1', 'Req', 6, '[\"assignee\"]')").run();
    const ok = addTask("c1", { assignees: ["Maria"] });
    const no = addTask("c1");
    const reqRes = await bulkHandler(bulk({ ids: [ok, no], action: "move", columnId: "c-req" }));
    expect(reqRes.status).toBe(200);
    const reqBody = await reqRes.json();
    expect(reqBody.applied).toEqual([ok]);
    expect(reqBody.failed).toEqual([{ id: no, code: "REQUIRED_FIELD", message: "Field 'assignee' is required in column 'Req'" }]);
    expect((bulkDb.prepare("SELECT column_id FROM tasks WHERE id = ?").get(ok) as { column_id: string }).column_id).toBe("c-req");
    expect((bulkDb.prepare("SELECT column_id FROM tasks WHERE id = ?").get(no) as { column_id: string }).column_id).toBe("c1");
  });

  it("rejects an id from another project per task without touching it", async () => {
    bulkDb.exec(`
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p2', 'P2', 'p2', 'EG2', 2000);
INSERT INTO columns (id, project_id, name, position) VALUES ('p2c1', 'p2', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('p2s', 'p2', 'Backlog', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at)
  VALUES ('other-task', 'p2', 'p2c1', 'p2s', 'Other', 'a0', 'EG2-1', 1, '2026-01-01 10:00:00');
`);
    const before = bulkDb.prepare("SELECT priority FROM tasks WHERE id = 'other-task'").get() as { priority: string | null };
    const a = addTask("c1");
    const res = await bulkHandler(bulk({ ids: [a, "other-task"], action: "update", priority: "prio-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual([a]);
    expect(body.failed).toEqual([{ id: "other-task", code: "TASK_NOT_FOUND", message: "Task not found" }]);
    expect((bulkDb.prepare("SELECT priority FROM tasks WHERE id = 'other-task'").get() as { priority: string | null }).priority).toBe(before.priority);
  });

  it("best-effort GitHub state sync on a bulk move to a mapped column never fails the request", async () => {
    bulkDb.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-gh', 'p1', 'GH', 8, 'closed')").run();
    const a = addTask("c1");
    bulkDb.prepare(
      "INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES (?, 'ghi-move', 43, 'owner/repo', 'open')"
    ).run(a);
    const res = await bulkHandler(bulk({ ids: [a], action: "move", columnId: "c-gh" }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([a]);
    expect((bulkDb.prepare("SELECT column_id FROM tasks WHERE id = ?").get(a) as { column_id: string }).column_id).toBe("c-gh");
    // State push failed (no App configured) but was swallowed; synced_state
    // stays as it was and the move already committed.
    const link = bulkDb.prepare(
      "SELECT synced_state FROM task_github_issues WHERE task_id = ? AND issue_id = 'ghi-move'"
    ).get(a) as { synced_state: string | null };
    expect(link.synced_state).toBe("open");
  });

  it("refuses bulk actions when the kill switch is on, and caps a request at 100 ids", async () => {
    // kill switch
    const a = addTask("c1");
    process.env.LXK_DISABLE_TASKS_BULK = "1";
    try {
      const res = await bulkHandler(bulk({ ids: [a], action: "update", priority: "prio-2" }));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("TASKS_BULK_DISABLED");
      expect((bulkDb.prepare("SELECT priority FROM tasks WHERE id = ?").get(a) as { priority: string }).priority).not.toBe("prio-2");
      expect(activityCount(a, "field_changed")).toBe(0);
    } finally {
      delete process.env.LXK_DISABLE_TASKS_BULK;
    }

    // 100-id cap
    const ids = Array.from({ length: 100 }, () => addTask("c2"));
    const ok = await bulkHandler(bulk({ ids, action: "update", priority: "prio-2" }));
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.failed).toEqual([]);
    expect(okBody.applied).toHaveLength(100);
    const changed = bulkDb.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE id IN (${ids.map(() => "?").join(",")}) AND priority = 'prio-2'`
    ).get(...ids) as { c: number };
    expect(changed.c).toBe(100);

    const over = Array.from({ length: 101 }, () => addTask("c2"));
    const refused = await bulkHandler(bulk({ ids: over, action: "update", priority: "prio-2" }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.code).toBe("INVALID_ARGS");
    const unchanged = bulkDb.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE id IN (${over.map(() => "?").join(",")}) AND priority = 'prio-2'`
    ).get(...over) as { c: number };
    expect(unchanged.c).toBe(0);
  });
});

describe("activity and mentions API", () => {
  const ADMIN2_KEY = "lxk_" + "b".repeat(43);
  const BODY = JSON.stringify({ body: "hi" });
  const EMPTY_BODY = JSON.stringify({ body: "" });
  const headers = (key = ADMIN_KEY) => ({
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });

  let actDir: string;
  let actHandler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    actDir = mkdtempSync(join(tmpdir(), "lexa-activity-api-"));
    const dbPath = join(actDir, "test.db");
    runMigrations(dbPath, MIGRATIONS);
    const adminHash = await sha256(ADMIN_KEY);
    const admin2Hash = await sha256(ADMIN2_KEY);
    const db = new Database(dbPath);
    db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'alex@lexa.test', 'Alex', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-admin2', '${admin2Hash}', 'u2');
-- p1: mention search fixtures.
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 3);
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2', 'admin', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1), ('c3', 'p1', 'In Review', 2);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO milestones (id, project_id, name, description, position, due_at) VALUES ('m1', 'p1', 'Q3 Launch', '', 0, '2026-09-30');
INSERT INTO milestones (id, project_id, name, description, position, due_at, archived_at) VALUES ('m-arch', 'p1', 'Q3 Archived Goal', '', 1, NULL, '2026-01-01 00:00:00');
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at, milestone_id) VALUES ('s-q3', 'p1', 'Q3 Sprint', 1, 'sprint', '2026-09-15', 'm1');
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at, archived_at) VALUES ('s-arch', 'p1', 'Q3 Archived Sprint', 2, 'sprint', NULL, '2026-01-01 00:00:00');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1', 'p1', 'c1', 's-backlog', 'Onboarding flow', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2', 'p1', 'c1', 's-backlog', 'Payment retry logic', 'a1', '2026-01-01 10:00:00', 'EG-2', 2);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, archived_at, created_at, key, number) VALUES ('t-arch', 'p1', 'c2', 's-backlog', 'Onboarding archived', 'a0', '2026-02-01 10:00:00', '2026-01-01 10:00:00', 'EG-9', 9);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Roadmap', 'roadmap', '', '', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w2', 'p1', 'Unrelated page', 'unrelated', '', '', 1);
-- Cap fixtures: 5 tasks + 5 wiki pages all matching q=capfill.
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t1', 'p1', 'c1', 's-backlog', 'Capfill one', 'b0', '2026-01-01 10:00:00', 'CF-1', 11);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t2', 'p1', 'c1', 's-backlog', 'Capfill two', 'b1', '2026-01-01 10:00:00', 'CF-2', 12);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t3', 'p1', 'c1', 's-backlog', 'Capfill three', 'b2', '2026-01-01 10:00:00', 'CF-3', 13);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t4', 'p1', 'c1', 's-backlog', 'Capfill four', 'b3', '2026-01-01 10:00:00', 'CF-4', 14);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t5', 'p1', 'c1', 's-backlog', 'Capfill five', 'b4', '2026-01-01 10:00:00', 'CF-5', 15);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w1', 'p1', 'Capfill w1', 'capfill-w1', '', '', 2);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w2', 'p1', 'Capfill w2', 'capfill-w2', '', '', 3);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w3', 'p1', 'Capfill w3', 'capfill-w3', '', '', 4);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w4', 'p1', 'Capfill w4', 'capfill-w4', '', '', 5);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w5', 'p1', 'Capfill w5', 'capfill-w5', '', '', 6);
-- Second project: its rows must never leak into p1 results.
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p2', 'Q', 'p2', 'ZZ', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c2-1', 'p2', 'Todo', 0), ('c2-3', 'p2', 'In Review', 2);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s2-backlog', 'p2', 'Backlog', 0, 'backlog');
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s2-q3', 'p2', 'Q3 Sprint elsewhere', 1, 'sprint');
INSERT INTO milestones (id, project_id, name, description, position, due_at) VALUES ('m2-zz', 'p2', 'Q3 Launch elsewhere', '', 0, NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2-zz', 'p2', 'c2-1', 's2-backlog', 'Onboarding elsewhere', 'a0', '2026-01-01 10:00:00', 'ZZ-1', 1);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w2-zz', 'p2', 'Roadmap elsewhere', 'roadmap-elsewhere', '', '', 0);
-- Activity timeline fixtures for t1: one seed event + one seed comment.
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at) VALUES ('t1', 'user', 'Maria', 'u1', 'created', 'Maria created this task', '2026-01-01 10:00:00');
INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, created_at) VALUES ('t1', 'u1', 'user', 'Maria', '', '2026-01-02 10:00:00');
`);
    db.close();
    actHandler = createApiHandler(dbPath);
  });

  afterAll(() => {
    rmSync(actDir, { recursive: true, force: true });
  });

  describe("GET /api/projects/:slug/tasks/:id/activity", () => {
    it("merges events and comments, pages with the cursor to the oldest, and 404s an unknown project", async () => {
      const page1 = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      expect(page1.status).toBe(200);
      const body1 = await page1.json();
      expect(body1.data).toHaveLength(1);
      expect(["event", "comment"]).toContain(body1.data[0].kind);
      expect(body1.nextCursor).toBeTruthy();

      const page2 = await actHandler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1&cursor=${encodeURIComponent(body1.nextCursor)}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      const body2 = await page2.json();
      expect(body2.data).toHaveLength(1);
      expect(body2.nextCursor).toBeNull();
      expect(body1.data[0].createdAt > body2.data[0].createdAt).toBe(true);

      const missing = await actHandler(new Request("http://lexa.test/api/projects/nope/tasks/t1/activity", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      expect(missing.status).toBe(404);
    });
  });

  describe("GET /api/projects/:slug/mentions contract", () => {
    it("caps at 8 with tasks first, excludes archived tasks, and never leaks another project", async () => {
      // 5 tasks + 5 wiki pages match q=capfill; only 3 wiki slots remain after tasks.
      const cap = await actHandler(new Request("http://lexa.test/api/projects/p1/mentions?q=capfill", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      expect(cap.status).toBe(200);
      const capBody = await cap.json();
      expect(capBody.data.tasks.map((t: { id: string }) => t.id)).toEqual(["cap-t1", "cap-t2", "cap-t3", "cap-t4", "cap-t5"]);
      expect(capBody.data.wikiPages.map((w: { id: string }) => w.id)).toEqual(["cap-w1", "cap-w2", "cap-w3"]);
      expect(capBody.data.tasks.length + capBody.data.wikiPages.length).toBeLessThanOrEqual(8);

      // archived tasks never match (t-arch is excluded); no foreign rows leak in
      const arch = await actHandler(new Request("http://lexa.test/api/projects/p1/mentions?q=onboarding", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      const archBody = await arch.json();
      expect(archBody.data.tasks.map((t: { id: string }) => t.id)).toEqual(["t1"]);
      expect(JSON.stringify(archBody)).not.toContain("t2-zz");
      expect(JSON.stringify(archBody)).not.toContain("w2-zz");

      const p1q3 = await actHandler(new Request("http://lexa.test/api/projects/p1/mentions?q=q3", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      const p1q3Body = await p1q3.json();
      expect(p1q3Body.data.milestones.map((m: { id: string }) => m.id)).toEqual(["m1"]);
      expect(p1q3Body.data.swimlanes.map((l: { id: string }) => l.id)).toEqual(["s-q3"]);
      expect(JSON.stringify(p1q3Body)).not.toContain("m2-zz");
      expect(JSON.stringify(p1q3Body)).not.toContain("s2-q3");

      const p2 = await actHandler(new Request("http://lexa.test/api/projects/p2/mentions?q=onboarding", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }));
      const p2Body = await p2.json();
      expect(p2Body.data.tasks.map((t: { id: string }) => t.id)).toEqual(["t2-zz"]);
      expect(JSON.stringify(p2Body)).not.toContain('"t1"');
    });
  });

  describe("comment endpoints", () => {
    it("creates a comment (201 with activity), rejects an invalid body (422), and lets author and project admin delete", async () => {
      const res = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
        method: "POST",
        headers: headers(),
        body: BODY,
      }));
      expect(res.status).toBe(201);
      const { data } = await res.json();
      expect(data.comment.authorLabel).toBe("Maria");
      expect(data.comment.body).toBe("hi");
      expect(data.activity.type).toBe("commented");
      expect(data.activity.message).toBe("Maria commented");

      const invalid = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
        method: "POST",
        headers: headers(),
        body: EMPTY_BODY,
      }));
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).error.code).toBe("COMMENT_INVALID");

      // author deletes their own comment
      const asAuthor = await actHandler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data.comment.id}`, {
        method: "DELETE",
        headers: headers(),
      }));
      expect(asAuthor.status).toBe(204);

      // a project admin who is not the author may also delete
      const created2 = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
        method: "POST",
        headers: headers(),
        body: BODY,
      }));
      const { data: data2 } = await created2.json();
      const asAdmin = await actHandler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data2.comment.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN2_KEY}` },
      }));
      expect(asAdmin.status).toBe(204);
    });
  });

  describe("mutation responses carry the appended activity (invariant #12)", () => {
    it("updateTask carries its appended activity; a no-op move emits none", async () => {
      const res = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1", {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      }));
      expect(res.status).toBe(200);
      const { data, activity } = await res.json();
      expect(data.title).toBe("New title");
      expect(activity).toHaveLength(1);
      expect(activity[0]!.type).toBe("field_changed");
      expect(activity[0]!.message).toBe("Maria changed the title");
      expect(activity[0]!.kind).toBe("event");

      const move = await actHandler(new Request("http://lexa.test/api/projects/p1/tasks/t1/move", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ columnId: "c1", swimlaneId: "s-backlog" }),
      }));
      expect(move.status).toBe(200);
      const moved = await move.json();
      expect(moved.data.title).toBe("New title");
      // no-op move (same column/lane, no neighbors) → no activity rows
      expect(moved.activity).toEqual([]);
    });
  });
});

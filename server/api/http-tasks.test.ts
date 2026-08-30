import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

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
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Roadmap', 'roadmap', '{"type":"doc","content":[]}', '', 0);
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

describe("tasks routes", () => {
  it("GET /api/projects/:slug/tasks lists tasks", async () => {
    const res = await handler(json("GET", "/api/projects/p1/tasks"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: { id: string }) => t.id)).toEqual(["t1", "t2"]);
    expect(body.nextCursor).toBeNull();
  });

  it("POST /api/projects/:slug/tasks creates a task with defaults (201)", async () => {
    const res = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c1", title: "New" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("New");
    expect(body.data.priority).toBe("prio-1");
    expect(body.data.swimlaneId).toBe("s-backlog");
  });

  it("POST task with an unknown column → 404 COLUMN_NOT_FOUND", async () => {
    const res = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "nope", title: "X" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("POST task into a column that requires assignee without one → 422 REQUIRED_FIELD", async () => {
    db.prepare("UPDATE columns SET required_fields = '[\"assignee\"]' WHERE id = 'c2'").run();
    const res = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c2", title: "No assignee" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("REQUIRED_FIELD");
    expect(body.error.details.field).toBe("assignee");
    const ok = await handler(json("POST", "/api/projects/p1/tasks", { columnId: "c2", title: "Has assignee", assignees: ["Maria"] }));
    expect(ok.status).toBe(201);
  });

  it("GET /api/projects/:slug/tasks/:id returns the task; unknown → 404", async () => {
    const ok = await handler(json("GET", "/api/projects/p1/tasks/t1"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe("t1");
    const missing = await handler(json("GET", "/api/projects/p1/tasks/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("TASK_NOT_FOUND");
  });

  it("PATCH /api/projects/:slug/tasks/:id updates", async () => {
    const res = await handler(json("PATCH", "/api/projects/p1/tasks/t1", { title: "Renamed" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("Renamed");
  });

  it("DELETE /api/projects/:slug/tasks/:id → 204 with an empty body, then the task is gone", async () => {
    const res = await handler(json("DELETE", "/api/projects/p1/tasks/t2"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const gone = await handler(json("GET", "/api/projects/p1/tasks/t2"));
    expect(gone.status).toBe(404);
  });
});

describe("task move routes", () => {
  it("move into a column at its WIP limit → 409 WIP_LIMIT with details", async () => {
    const created = await handler(json("POST", "/api/projects/p1/columns", { name: "Wip", wipLimit: 1 }));
    const { id } = await created.json();
    await handler(json("POST", "/api/projects/p1/tasks", { columnId: id, title: "Filler" }));
    const res = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: id, swimlaneId: "s-backlog" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("WIP_LIMIT");
    expect(body.error.details).toMatchObject({ column: "Wip", limit: 1, current: 1 });
  });

  it("move with a position conflict → 409 CONSTRAINT { isPositionConflict: true }", async () => {
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c-cf', 'p1', 'Conflict', 9)").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d1','p1','c-cf','s-backlog','D1','a1','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d2','p1','c-cf','s-backlog','D2','a1V','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d3','p1','c-cf','s-backlog','D3','a2','2026-01-01 10:00:00')").run();
    const res = await handler(json("POST", "/api/projects/p1/tasks/t1/move", {
      columnId: "c-cf", swimlaneId: "s-backlog", afterTaskId: "d1", beforeTaskId: "d3",
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONSTRAINT");
    expect(body.error.details.isPositionConflict).toBe(true);
  });

  it("move with a due date later than the target lane's deadline → 409; clearDueAt bypasses", async () => {
    const blocked = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: "c1", swimlaneId: "m1" }));
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe("DEADLINE_AFTER_LANE");
    expect(body.error.details.date).toBe("2026-06-01");
    const cleared = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: "c1", swimlaneId: "m1", clearDueAt: true }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.dueAt).toBeNull();
  });

  it("move into an archived lane → 404 SWIMLANE_NOT_FOUND", async () => {
    db.prepare("UPDATE swimlanes SET archived_at = '2026-03-01T00:00:00.000Z' WHERE id = 'm1'").run();
    const res = await handler(json("POST", "/api/projects/p1/tasks/t1/move", { columnId: "c1", swimlaneId: "m1" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SWIMLANE_NOT_FOUND");
  });
});

describe("task ticket key routes", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p-key', 'Key', 'p-key', 'EMB')").run();
    db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p-key2', 'Key2', 'p-key2', 'WC')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('ck1', 'p-key', 'Todo', 0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('sk', 'p-key', 'Backlog', 0, 'backlog')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number, created_at) VALUES ('tk1', 'p-key', 'ck1', 'sk', 'Key Task', 'a0', 'EMB-1', 1, '2026-01-01 10:00:00')").run();
  });

  it("GET by ticket key resolves the task", async () => {
    const res = await handler(json("GET", "/api/projects/p-key/tasks/EMB-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("EMB-1");
  });
});

describe("board route", () => {
  it("GET /api/projects/:slug/board returns the full snapshot", async () => {
    db.prepare("INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p-board', 'Board', 'p-board', 'PB', 2)").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('cb1', 'p-board', 'Todo', 0), ('cb2', 'p-board', 'Done', 1)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('sb', 'p-board', 'Backlog', 0, 'backlog')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('tb1', 'p-board', 'cb1', 'sb', 'B1', 'a0', '2026-01-01 10:00:00', 'PB-1', 1)").run();
    const res = await handler(json("GET", "/api/projects/p-board/board"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.slug).toBe("p-board");
    expect(body.columns.map((c: { id: string }) => c.id)).toEqual(["cb1", "cb2"]);
    expect(body.swimlanes.map((l: { id: string }) => l.id)).toEqual(["sb"]);
  });

  it("GET /api/projects/:slug/mentions matches task key + title, wiki title/slug; empty q → empty", async () => {
    const byKey = await handler(json("GET", "/api/projects/p1/mentions?q=eg-1"));
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toEqual({ data: { tasks: [{ id: "t1", key: "EG-1", title: "Renamed" }], wikiPages: [] } });

    const byTitle = await handler(json("GET", "/api/projects/p1/mentions?q=renamed"));
    expect((await byTitle.json()).data.tasks.map((t: { id: string }) => t.id)).toEqual(["t1"]);

    const byWiki = await handler(json("GET", "/api/projects/p1/mentions?q=road"));
    expect((await byWiki.json()).data.wikiPages).toEqual([{ id: "w1", slug: "roadmap", title: "Roadmap" }]);

    const empty = await handler(json("GET", "/api/projects/p1/mentions?q="));
    expect(await empty.json()).toEqual({ data: { tasks: [], wikiPages: [] } });
  });
});

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
const MEMBER_KEY = "lxk_" + "m".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-projects-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member'), ('u3', 'pam@lexa.test', 'Pam', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u3');
INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-a', 'Team A', 'team-a', '2026-01-01T00:00:00.000Z');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 2);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1', 'p1', 'Milestone 1', 1, 'sprint', '2026-06-01');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0), ('prio-2', 'p1', 'High', '#f00', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Bug', '#f00', 0), ('type-2', 'p1', 'Feature', '#0f0', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at, key, number) VALUES ('t1', 'p1', 'c1', 'm1', 'T1', 'a0', '2026-06-15', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2', 'p1', 'c2', 's-backlog', 'T2', 'a0', '2026-01-01 10:00:00', 'EG-2', 2);
`);
  db.close();
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("projects routes", () => {
  it("GET /api/projects lists projects", async () => {
    const res = await handler(json("GET", "/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!).toMatchObject({ id: "p1", slug: "p1", name: "P" });
    expect(body.nextCursor).toBeNull();
  });

  it("POST /api/projects creates a project (201)", async () => {
    const res = await handler(json("POST", "/api/projects", { name: "Second", slug: "second" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Second", slug: "second", description: "" });
    expect(body.id).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
  });

  it("POST /api/projects with teamId assigns the owning team (201)", async () => {
    const res = await handler(json("POST", "/api/projects", { name: "Teamed", slug: "teamed", teamId: "team-a" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ slug: "teamed", teamId: "team-a" });
  });

  it("POST /api/projects with an unknown teamId → 404 TEAM_NOT_FOUND", async () => {
    const res = await handler(json("POST", "/api/projects", { name: "Ghost", slug: "ghost-team", teamId: "team-ghost" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("TEAM_NOT_FOUND");
  });

  it("POST /api/projects with a taken slug → 409 SLUG_TAKEN", async () => {
    const res = await handler(json("POST", "/api/projects", { name: "Dupe", slug: "p1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("SLUG_TAKEN");
  });

  it("GET /api/projects/:slug returns the project; unknown slug → 404", async () => {
    const ok = await handler(json("GET", "/api/projects/p1"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).slug).toBe("p1");
    const missing = await handler(json("GET", "/api/projects/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PATCH /api/projects/:slug renames the project; unknown slug → 404", async () => {
    const ok = await handler(json("PATCH", "/api/projects/p1", { name: "Renamed" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("Renamed");
    const missing = await handler(json("PATCH", "/api/projects/nope", { name: "X" }));
    expect(missing.status).toBe(404);
  });

  it("DELETE /api/projects/:slug → 204 with an empty body, then the project is gone", async () => {
    const created = await handler(json("POST", "/api/projects", { name: "Temp", slug: "tmp-del" }));
    expect(created.status).toBe(201);
    const del = await handler(json("DELETE", "/api/projects/tmp-del"));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const gone = await handler(json("GET", "/api/projects/tmp-del"));
    expect(gone.status).toBe(404);
  });

  it("a member-bound key is denied on admin routes → 403 FORBIDDEN", async () => {
    const res = await handler(json("POST", "/api/projects", { name: "Nope", slug: "nope" }, MEMBER_KEY));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("rejects without a key → 401", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects"));
    expect(res.status).toBe(401);
  });
});

describe("columns routes", () => {
  it("GET /api/projects/:slug/columns lists columns ordered by position", async () => {
    const res = await handler(json("GET", "/api/projects/p1/columns"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);
  });

  it("POST /api/projects/:slug/columns appends a column (201); unknown project → 404", async () => {
    const ok = await handler(json("POST", "/api/projects/p1/columns", { name: "Review" }));
    expect(ok.status).toBe(201);
    const col = await ok.json();
    expect(col).toMatchObject({ name: "Review", projectId: "p1", position: 2 });
    const missing = await handler(json("POST", "/api/projects/nope/columns", { name: "X" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PATCH /api/projects/:slug/columns/:id renames; unknown column → 404", async () => {
    const ok = await handler(json("PATCH", "/api/projects/p1/columns/c1", { name: "TodoX" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("TodoX");
    const missing = await handler(json("PATCH", "/api/projects/p1/columns/nope", { name: "X" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("DELETE a column with tasks → 409 HAS_CHILDREN; an empty column → 204", async () => {
    const blocked = await handler(json("DELETE", "/api/projects/p1/columns/c1"));
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe("HAS_CHILDREN");
    expect(body.error.details.count).toBeGreaterThan(0);
    const created = await handler(json("POST", "/api/projects/p1/columns", { name: "Empty" }));
    const { id } = await created.json();
    const del = await handler(json("DELETE", `/api/projects/p1/columns/${id}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });

  it("member-bound key → 403 on column create", async () => {
    const res = await handler(json("POST", "/api/projects/p1/columns", { name: "Nope" }, MEMBER_KEY));
    expect(res.status).toBe(403);
  });
});

describe("swimlane routes", () => {
  it("GET /api/projects/:slug/swimlanes lists lanes including archived", async () => {
    const res = await handler(json("GET", "/api/projects/p1/swimlanes"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((l: { id: string }) => l.id)).toEqual(["s-backlog", "m1"]);
    expect(body.data[0]!.kind).toBe("backlog");
    expect(body.data[1]!.dueAt).toBe("2026-06-01");
  });

  it("POST /api/projects/:slug/swimlanes creates a sprint lane (201); unknown project → 404", async () => {
    const ok = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "M2", dueAt: "2026-08-01" }));
    expect(ok.status).toBe(201);
    const lane = await ok.json();
    expect(lane).toMatchObject({ kind: "sprint", dueAt: "2026-08-01", position: 2 });
    const missing = await handler(json("POST", "/api/projects/nope/swimlanes", { name: "X" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PATCH shrinking the deadline past a task's due date → 409 DEADLINE_AFTER_LANE", async () => {
    // t1 in m1 has due_at 2026-06-15. The payload schema requires name even
    // on PATCH (docs say name? optional — see report).
    const res = await handler(json("PATCH", "/api/projects/p1/swimlanes/m1", { name: "Milestone 1", dueAt: "2026-06-10" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("DEADLINE_AFTER_LANE");
    expect(body.error.details.date).toBe("2026-06-10");
    expect(body.error.details.taskId).toBe("t1");
    // Moving the deadline after every task's due date is allowed.
    const ok = await handler(json("PATCH", "/api/projects/p1/swimlanes/m1", { name: "Milestone 1", dueAt: "2026-06-20" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).dueAt).toBe("2026-06-20");
  });

  it("PATCH without name is allowed (partial update)", async () => {
    const res = await handler(json("PATCH", "/api/projects/p1/swimlanes/m1", { dueAt: "2026-06-20" }));
    expect(res.status).toBe(200);
    expect((await res.json()).dueAt).toBe("2026-06-20");
  });

  it("PATCH setting a deadline on the backlog lane → 409 BACKLOG_PROTECTED", async () => {
    const res = await handler(json("PATCH", "/api/projects/p1/swimlanes/s-backlog", { name: "Backlog", dueAt: "2026-01-01" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("BACKLOG_PROTECTED");
    expect(body.error.details.action).toBe("deadline");
  });

  it("DELETE the backlog lane → 409 BACKLOG_PROTECTED", async () => {
    const res = await handler(json("DELETE", "/api/projects/p1/swimlanes/s-backlog"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("BACKLOG_PROTECTED");
    expect(body.error.details.action).toBe("delete");
  });

  it("DELETE a lane with tasks → 409 HAS_CHILDREN; an empty lane → 204", async () => {
    const blocked = await handler(json("DELETE", "/api/projects/p1/swimlanes/m1"));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("HAS_CHILDREN");
    const created = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "Empty" }));
    const { id } = await created.json();
    const del = await handler(json("DELETE", `/api/projects/p1/swimlanes/${id}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });

  it("POST archive archives the lane and its tasks; backlog archive → 409 BACKLOG_PROTECTED", async () => {
    const res = await handler(json("POST", "/api/projects/p1/swimlanes/m1/archive"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.archivedAt).toBeTruthy();
    expect(body.activity).toHaveLength(1); // t1 archived
    expect(body.activity[0]!.type).toBe("archived");
    const backlog = await handler(json("POST", "/api/projects/p1/swimlanes/s-backlog/archive"));
    expect(backlog.status).toBe(409);
    expect((await backlog.json()).error.code).toBe("BACKLOG_PROTECTED");
  });

  it("POST restore clears archivedAt; archive/restore unknown lane → 404", async () => {
    await handler(json("POST", "/api/projects/p1/swimlanes/m1/archive"));
    const res = await handler(json("POST", "/api/projects/p1/swimlanes/m1/restore"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.archivedAt).toBeNull();
    const missing = await handler(json("POST", "/api/projects/p1/swimlanes/nope/archive"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("SWIMLANE_NOT_FOUND");
  });
});

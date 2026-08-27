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
  dir = mkdtempSync(join(tmpdir(), "lexa-milestones-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO milestones (id, project_id, name, position) VALUES ('ms-seed', 'p1', 'v0', 0);
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

describe("milestones routes", () => {
  it("POST creates a milestone; GET lists it with sprint counts; board includes milestones", async () => {
    const res = await handler(json("POST", "/api/projects/p1/milestones", { name: "v1", dueAt: "2026-08-30" }));
    const created = await res.json();
    expect(res.status).toBe(201);
    expect(created.name).toBe("v1");
    expect(created.sprintCount).toBe(0);
    const list = await handler(json("GET", "/api/projects/p1/milestones"));
    expect(list.status).toBe(200);
    const data = (await list.json()).data;
    expect(data).toHaveLength(2); // seeded + created
    expect(data[1]!).toMatchObject({ name: "v1", dueAt: "2026-08-30", sprintCount: 0, archivedSprintCount: 0 });
    const board = await handler(json("GET", "/api/projects/p1/board"));
    const body = await board.json();
    expect(Array.isArray(body.milestones)).toBe(true);
    expect(body.milestones.map((m: { name: string }) => m.name)).toEqual(["v0", "v1"]);
  });

  it("POST with unknown project → 404 PROJECT_NOT_FOUND", async () => {
    const res = await handler(json("POST", "/api/projects/nope/milestones", { name: "x" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PATCH updates name/description/dueAt; unknown id → 404 MILESTONE_NOT_FOUND", async () => {
    const ok = await handler(json("PATCH", "/api/projects/p1/milestones/ms-seed", { name: "v0.1", dueAt: null }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.name).toBe("v0.1");
    expect(body.dueAt).toBeNull();
    const missing = await handler(json("PATCH", "/api/projects/p1/milestones/nope", { name: "x" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("MILESTONE_NOT_FOUND");
  });

  it("DELETE with sprints → 409 HAS_CHILDREN; empty milestone → 204", async () => {
    const created = await handler(json("POST", "/api/projects/p1/milestones", { name: "with-sprints" }));
    const m = await created.json();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id) VALUES ('sp1','p1','Sprint 1',1,'sprint',?)").run(m.id);
    const blocked = await handler(json("DELETE", `/api/projects/p1/milestones/${m.id}`));
    expect(blocked.status).toBe(409);
    const err = await blocked.json();
    expect(err.error.code).toBe("HAS_CHILDREN");
    expect(err.error.details.count).toBe(1);
    // The service guards delete while sprints exist (ON DELETE SET NULL is
    // only the DB-level fallback) — loosen the sprint first.
    db.prepare("UPDATE swimlanes SET milestone_id = NULL WHERE id = 'sp1'").run();
    const ok = await handler(json("DELETE", `/api/projects/p1/milestones/${m.id}`));
    expect(ok.status).toBe(204);
  });

  it("POST archive cascades: milestone + its sprint + live task archived, per-task activity; restore brings milestone back only", async () => {
    const created = await handler(json("POST", "/api/projects/p1/milestones", { name: "v2" }));
    const m = await created.json();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id) VALUES ('sp2','p1','Sprint 2',1,'sprint',?)").run(m.id);
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t-ar','p1','c1','sp2','T','a0','2026-01-01 10:00:00','EG-1',1)").run();
    const archived = await handler(json("POST", `/api/projects/p1/milestones/${m.id}/archive`));
    expect(archived.status).toBe(200);
    const aBody = await archived.json();
    expect(aBody.data.archivedAt).not.toBeNull();
    expect(aBody.data.sprintCount).toBe(1); // mutation responses carry real counts
    expect(aBody.activity.map((a: { type: string }) => a.type)).toEqual(["archived"]);
    expect(aBody.activity[0]!).toMatchObject({ actorLabel: "Maria", message: "Maria archived this task" });
    const lane = db.prepare("SELECT archived_at FROM swimlanes WHERE id = 'sp2'").get() as { archived_at: string | null };
    expect(lane.archived_at).not.toBeNull();
    const task = db.prepare("SELECT archived_at FROM tasks WHERE id = 't-ar'").get() as { archived_at: string | null };
    expect(task.archived_at).not.toBeNull();
    // Idempotent second archive.
    const again = await handler(json("POST", `/api/projects/p1/milestones/${m.id}/archive`));
    expect((await again.json()).activity).toEqual([]);
    // Restore: milestone back, sprint stays archived.
    const restored = await handler(json("POST", `/api/projects/p1/milestones/${m.id}/restore`));
    const rBody = await restored.json();
    expect(rBody.data.archivedAt).toBeNull();
    const laneAfter = db.prepare("SELECT archived_at FROM swimlanes WHERE id = 'sp2'").get() as { archived_at: string | null };
    expect(laneAfter.archived_at).not.toBeNull();
  });

  it("unknown milestone on archive/restore → 404 MILESTONE_NOT_FOUND", async () => {
    const archived = await handler(json("POST", "/api/projects/p1/milestones/nope/archive"));
    expect(archived.status).toBe(404);
    expect((await archived.json()).error.code).toBe("MILESTONE_NOT_FOUND");
  });
});

describe("swimlane sprint-field routes", () => {
  it("POST/PATCH persist startAt + milestoneId; PATCH with startAt > dueAt → 422 INVALID_ARGS", async () => {
    const created = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "Sprint A", startAt: "2026-08-10", dueAt: "2026-08-30", milestoneId: "ms-seed" }));
    expect(created.status).toBe(201);
    const lane = await created.json();
    expect(lane.startAt).toBe("2026-08-10");
    expect(lane.milestoneId).toBe("ms-seed");
    expect(lane.kind).toBe("sprint");
    const patched = await handler(json("PATCH", `/api/projects/p1/swimlanes/${lane.id}`, { startAt: "2026-09-01", dueAt: "2026-08-01" }));
    expect(patched.status).toBe(422);
    expect((await patched.json()).error.code).toBe("INVALID_ARGS");
  });

  it("swimlane with unknown milestoneId → 404 MILESTONE_NOT_FOUND", async () => {
    const res = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "Bad", milestoneId: "nope" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("MILESTONE_NOT_FOUND");
  });
});

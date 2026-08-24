import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "b".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

const adminReq = (path: string, init: RequestInit = {}) =>
  new Request(`http://lexa.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

const upsertBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    documentType: "task",
    documentId: "t1",
    runtimeId: "rt1",
    runtimeSessionId: "sess-1",
    provider: "opencode",
    agentId: "a1",
    skillId: "sk1",
    ...over,
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-hearth-sessions-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash) VALUES ('k1', 'test-admin', '${adminHash}');
INSERT INTO runtimes (id, name, provider, model, status, agent, print_logs, log_level) VALUES
  ('rt1', 'dev', 'opencode', 'claude', 'online', 'lexa', 0, 'INFO'),
  ('rt2', 'dev2', 'opencode', 'claude', 'online', 'lexa', 0, 'INFO');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Main', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'T1', '{"type":"doc","content":[]}', 'pr-1', 'tp-1', 'a0', '2026-01-01 10:00:00');
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES
  ('a1', 'Test Agent', '', 'Agent instructions', 0);
INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES
  ('sk1', 'Test Skill', '', 'Skill instructions', 0);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/hearth/sessions", () => {
  it("upserts a mapping with 204 and no body", async () => {
    const res = await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("upserting the same ref twice rewrites the row (204 both times)", async () => {
    const res1 = await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    expect(res1.status).toBe(204);
    const res2 = await handler(adminReq("/api/hearth/sessions", {
      method: "PUT",
      body: upsertBody({ runtimeSessionId: "sess-2", skillId: "sk2" }),
    }));
    expect(res2.status).toBe(204);
    const list = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].runtimeSessionId).toBe("sess-2");
    expect(body.data[0].skillId).toBe("sk2");
  });
});

describe("GET /api/hearth/sessions", () => {
  it("returns the mapping as data (camelCase, updatedAt set)", async () => {
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0];
    expect(row.documentType).toBe("task");
    expect(row.documentId).toBe("t1");
    expect(row.runtimeId).toBe("rt1");
    expect(row.runtimeSessionId).toBe("sess-1");
    expect(row.provider).toBe("opencode");
    expect(row.agentId).toBe("a1");
    expect(row.skillId).toBe("sk1");
    expect(typeof row.createdAt).toBe("string");
    expect(typeof row.updatedAt).toBe("string");
  });

  it("is scoped to the document — other documents get an empty list", async () => {
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions?documentType=wiki&documentId=w1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it("missing query params are an empty list, not an error", async () => {
    const res = await handler(adminReq("/api/hearth/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

describe("DELETE /api/hearth/sessions", () => {
  it("removes the mapping with 204", async () => {
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions", { method: "DELETE", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
    const list = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    const body = await list.json();
    expect(body.data).toEqual([]);
  });

  it("does NOT 409 when a task is running for the document (daemon-side drop)", async () => {
    db.prepare(
      `INSERT INTO hearth_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id, created_at)
       VALUES ('ft1', 'p1', 'task', 't1', 'a1', 'sk1', 'running', 'rt1', datetime('now'))`
    ).run();
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions", { method: "DELETE", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
    const list = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    const body = await list.json();
    expect(body.data).toEqual([]);
    db.prepare("DELETE FROM hearth_tasks WHERE id = 'ft1'").run();
  });

  it("deleting a missing mapping is 204, not 404", async () => {
    const res = await handler(adminReq("/api/hearth/sessions", { method: "DELETE", body: JSON.stringify({ documentType: "task", documentId: "ghost", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
  });
});

describe("POST /api/hearth/sessions/reset", () => {
  it("deletes the mapping with 204", async () => {
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
    const list = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    const body = await list.json();
    expect(body.data).toEqual([]);
  });

  it("resets only the given runtime's mapping", async () => {
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody({ runtimeId: "rt1" }) }));
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody({ runtimeId: "rt2" }) }));
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
    const list = await handler(adminReq("/api/hearth/sessions?documentType=task&documentId=t1"));
    const body = await list.json();
    expect(body.data.map((r: { runtimeId: string }) => r.runtimeId)).toEqual(["rt2"]);
  });

  it("409 HEARTH_SESSION_ACTIVE when a queued task exists for the document+runtime", async () => {
    db.prepare(
      `INSERT INTO hearth_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id, created_at)
       VALUES ('ft2', 'p1', 'task', 't1', 'a1', 'sk1', 'queued', 'rt1', datetime('now'))`
    ).run();
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("HEARTH_SESSION_ACTIVE");
    db.prepare("DELETE FROM hearth_tasks WHERE id = 'ft2'").run();
  });

  it("409 when a running task exists for the document+runtime", async () => {
    db.prepare(
      `INSERT INTO hearth_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id, created_at)
       VALUES ('ft3', 'p1', 'task', 't1', 'a1', 'sk1', 'running', 'rt1', datetime('now'))`
    ).run();
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(409);
    db.prepare("DELETE FROM hearth_tasks WHERE id = 'ft3'").run();
  });

  it("204 when the active task is on a different runtime (per-runtime reset)", async () => {
    db.prepare(
      `INSERT INTO hearth_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id, created_at)
       VALUES ('ft4', 'p1', 'task', 't1', 'a1', 'sk1', 'running', 'rt2', datetime('now'))`
    ).run();
    await handler(adminReq("/api/hearth/sessions", { method: "PUT", body: upsertBody() }));
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "t1", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
    db.prepare("DELETE FROM hearth_tasks WHERE id = 'ft4'").run();
  });

  it("no 404s: resetting a missing mapping is 204", async () => {
    const res = await handler(adminReq("/api/hearth/sessions/reset", { method: "POST", body: JSON.stringify({ documentType: "task", documentId: "ghost", runtimeId: "rt1" }) }));
    expect(res.status).toBe(204);
  });
});

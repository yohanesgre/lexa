import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "r".repeat(43);
const MEMBER_KEY = "lxk_" + "s".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (path: string, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });

const post = (path: string, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-runs-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
    INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha'), ('p2','Beta','beta');
    INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2','member','p1');
    INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1','A','','',0);
    INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1','S','','',0);
  `);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => { db.prepare("DELETE FROM assistant_tasks").run(); db.prepare("DELETE FROM assistant_runs").run(); });

function insertTask(id: string, status: string, projectId: string, createdAt: string) {
  db.prepare(
    "INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, error, created_at) VALUES (?, ?, 'task', 't1', 'a1', 'sk1', ?, ?, ?)"
  ).run(id, projectId, status, status === "failed" ? "boom" : null, createdAt);
}

function insertRun(id: string, kind: string, status: string, projectId: string, createdAt: string, threadKey = "chat:c1") {
  db.prepare(
    "INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, created_at) VALUES (?, ?, ?, ?, ?, 'g', ?)"
  ).run(id, projectId, threadKey, kind, status, createdAt);
}

describe("GET /api/admin/assistant/runs", () => {
  it("superadmin gets metadata rows, counts, and no result/extraPrompt/selection", async () => {
    insertTask("r1", "completed", "p1", "2026-01-01 10:00:00");
    insertTask("r2", "failed", "p1", "2026-01-02 10:00:00");
    const res = await handler(authed("/api/admin/assistant/runs"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; nextCursor: string | null; counts: Record<string, number> };
    expect(body.data.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(body.nextCursor).toBeNull();
    expect(body.counts).toEqual({ queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 });
    const first = body.data[0]!;
    expect(first.error).toBe("boom");
    expect(first.documentTitle).toBe("");
    expect(first.kind).toBe("document");
    expect(first.threadKey).toBe("task:t1");
    expect("result" in first).toBe(false);
    expect("extraPrompt" in first).toBe(false);
    expect("selection" in first).toBe(false);
  });

  it("unions registry runs (kind chat_run/schedule) with nullable document fields", async () => {
    insertTask("t1", "completed", "p1", "2026-01-01 10:00:00");
    insertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00", "chat:c9");
    insertRun("s1", "schedule", "queued", "p1", "2026-01-03 10:00:00");
    const res = await handler(authed("/api/admin/assistant/runs"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; counts: Record<string, number> };
    expect(body.data.map((r) => r.id)).toEqual(["s1", "r1", "t1"]);
    const run = body.data.find((r) => r.id === "r1")!;
    expect(run.kind).toBe("chat_run");
    expect(run.documentType).toBeNull();
    expect(run.documentId).toBe("");
    expect(run.threadKey).toBe("chat:c9");
    expect(run.key).toBe("r1");
    // counts span both tables (union GROUP BY): 1 completed + 1 running + 1 queued.
    expect(body.counts).toEqual({ queued: 1, running: 1, completed: 1, failed: 0, cancelled: 0 });
  });

  it("filters by kind", async () => {
    insertTask("t1", "completed", "p1", "2026-01-01 10:00:00");
    insertRun("r1", "chat_run", "completed", "p1", "2026-01-02 10:00:00");
    insertRun("s1", "schedule", "completed", "p1", "2026-01-03 10:00:00");
    const res = await handler(authed("/api/admin/assistant/runs?kind=schedule"));
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((r) => r.id)).toEqual(["s1"]);
    const bad = await handler(authed("/api/admin/assistant/runs?kind=bogus"));
    expect(bad.status).toBe(422);
  });

  it("member → 403", async () => {
    const res = await handler(authed("/api/admin/assistant/runs", MEMBER_KEY));
    expect(res.status).toBe(403);
  });

  it("filters by status and projectId", async () => {
    insertTask("r1", "completed", "p1", "2026-01-01 10:00:00");
    insertTask("r2", "failed", "p1", "2026-01-02 10:00:00");
    insertTask("r3", "failed", "p2", "2026-01-03 10:00:00");
    const byStatus = await handler(authed("/api/admin/assistant/runs?status=failed"));
    const statusBody = await byStatus.json() as { data: Array<{ id: string }> };
    expect(statusBody.data.map((r) => r.id)).toEqual(["r3", "r2"]);
    const byProject = await handler(authed("/api/admin/assistant/runs?projectId=p1"));
    const projectBody = await byProject.json() as { data: Array<{ id: string }> };
    expect(projectBody.data.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("rejects an unknown status", async () => {
    const res = await handler(authed("/api/admin/assistant/runs?status=bogus"));
    expect(res.status).toBe(422);
  });

  it("caps limit at 200", async () => {
    const stmt = db.prepare(
      "INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, created_at) VALUES (?, 'p1', 'task', 't1', 'a1', 'sk1', 'queued', ?)"
    );
    for (let i = 0; i < 205; i++) {
      const mm = String(Math.floor(i / 60)).padStart(2, "0");
      const ss = String(i % 60).padStart(2, "0");
      stmt.run(`r${String(i).padStart(3, "0")}`, `2026-01-01 00:${mm}:${ss}`);
    }
    const res = await handler(authed("/api/admin/assistant/runs?limit=999"));
    const body = await res.json() as { data: unknown[]; nextCursor: string | null };
    expect(body.data.length).toBe(200);
    expect(body.nextCursor).not.toBeNull();
  });

  it("paginates with a keyset cursor", async () => {
    insertTask("r1", "queued", "p1", "2026-01-01 10:00:00");
    insertTask("r2", "queued", "p1", "2026-01-02 10:00:00");
    insertTask("r3", "queued", "p1", "2026-01-03 10:00:00");
    const first = await handler(authed("/api/admin/assistant/runs?limit=2"));
    const firstBody = await first.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.data.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await handler(authed(`/api/admin/assistant/runs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`));
    const secondBody = await second.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(secondBody.data.map((r) => r.id)).toEqual(["r1"]);
    expect(secondBody.nextCursor).toBeNull();
  });
});

// `createAssistantApiHandler` injects `assistantThreadRpcNoop`, so these suites
// also pin the Bun / no-DO ack path.
describe("GET /api/assistant/runs/:runId", () => {
  it("serves a superadmin the persisted run columns only", async () => {
    insertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00", "chat:c9");
    const res = await handler(authed("/api/assistant/runs/r1"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "r1",
      projectId: "p1",
      threadKey: "chat:c9",
      parentRunId: null,
      kind: "chat_run",
      status: "running",
      goal: "g",
      stepsUsed: 0,
      startedAt: null,
      finishedAt: null,
    });
    // The live event log is session-memory only — never part of the REST row.
    expect("events" in body).toBe(false);
  });

  it("serves a member their own project's run", async () => {
    insertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00");
    const res = await handler(authed("/api/assistant/runs/r1", MEMBER_KEY));
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }).id).toBe("r1");
  });

  it("403s a member on a foreign project's run", async () => {
    insertRun("r2", "chat_run", "running", "p2", "2026-01-02 10:00:00");
    const res = await handler(authed("/api/assistant/runs/r2", MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("404s an unknown run id", async () => {
    const res = await handler(authed("/api/assistant/runs/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");
  });
});

describe("POST /api/assistant/runs/:runId/abort", () => {
  it("acks on the no-DO flavor and leaves the running row untouched", async () => {
    insertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00");
    const res = await handler(post("/api/assistant/runs/r1/abort"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // No DO answered: the handler still acks; no D1 transition is attempted.
    expect(db.prepare("SELECT status FROM assistant_runs WHERE id = 'r1'").get()).toMatchObject({ status: "running" });
  });

  it("is a no-op ack on a terminal run", async () => {
    insertRun("r1", "chat_run", "completed", "p1", "2026-01-02 10:00:00");
    const res = await handler(post("/api/assistant/runs/r1/abort"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.prepare("SELECT status FROM assistant_runs WHERE id = 'r1'").get()).toMatchObject({ status: "completed" });
  });

  it("lets a member abort their own project's run", async () => {
    insertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00");
    const res = await handler(post("/api/assistant/runs/r1/abort", MEMBER_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("403s a member on a foreign run and 404s an unknown id", async () => {
    insertRun("r2", "chat_run", "running", "p2", "2026-01-02 10:00:00");
    const foreign = await handler(post("/api/assistant/runs/r2", MEMBER_KEY));
    expect(foreign.status).toBe(403);
    const missing = await handler(post("/api/assistant/runs/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");
  });
});

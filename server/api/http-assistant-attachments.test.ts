import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import type { AssistantThreadRpcShape } from "../assistant/thread-rpc";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "c".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 20]);

let dir: string;
let dbPath: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

function uploadReq(path: string, bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as BlobPart]), filename);
  return new Request(`http://lexa.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
    body: form,
  });
}

function assistantTaskBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: "p1",
    documentType: "task",
    documentId: "t1",
    prompt: "describe the screenshot",
    agentId: "assistant",
    skillId: "skill-t1",
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-attachments-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'HG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1', 'p1', 'c1', 's-backlog', 'T1', 'a0', '2026-01-01 10:00:00', 'HG-1', 1);
INSERT INTO lexa_skills (id, name, description, instructions) VALUES ('skill-t1', 'Describe image', '', 'look at the image');
INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('assistant', 'skill-t1');
`);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/assistant/settings/:projectId", () => {
  it("fresh project PUT without legacy provider fields → 200 (gateway registry supplies provider)", async () => {
    const res = await handler(
      authed("PUT", "/api/assistant/settings/p1", {
        fallbackModelIds: [],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe("p1");
    expect(Array.isArray(body.fallbackModelIds ?? [])).toBe(true);
  });

  it("PUT with primarySupportsImages → masked view reflects it", async () => {
    const res = await handler(
      authed("PUT", "/api/assistant/settings/p1", {
        primarySupportsImages: true,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.primarySupportsImages).toBe(true);
  });
});

describe("POST /api/assistant/tasks attachments", () => {
  it("unscoped storageKey → 422 INVALID_ARGS", async () => {
    const res = await handler(
      authed("POST", "/api/assistant/tasks", assistantTaskBody({
        attachments: [{ storageKey: "blobs/other-project-key", mimeType: "image/png", name: "sneaky.png" }],
      }))
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(body.error.message).toContain("does not belong to this project");
  });

  it("scoped storageKey → 201 + image-ref part persisted in assistant_threads", async () => {
    const up = await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", PNG_BYTES, "shot.png"));
    expect(up.status).toBe(201);
    const att = (await up.json()).data;
    const row = db.prepare("SELECT storage_key FROM attachments WHERE id = ?").get(att.id) as { storage_key: string };

    const res = await handler(
      authed("POST", "/api/assistant/tasks", assistantTaskBody({
        attachments: [{ storageKey: row.storage_key, mimeType: "image/png", name: "shot.png" }],
      }))
    );
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.status).toBe("queued");

    const thread = db
      .prepare("SELECT messages FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'")
      .get() as { messages: string };
    const messages = JSON.parse(thread.messages) as Array<{ role: string; content: unknown[] }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toEqual([
      { type: "image-ref", storageKey: row.storage_key, mimeType: "image/png" },
    ]);
  });

  it("omits skillId → 201 auto mode (no SKILL_NOT_FOUND) and the persisted row carries skill_id NULL", async () => {
    const auto = assistantTaskBody();
    delete (auto as { skillId?: unknown }).skillId;
    const res = await handler(authed("POST", "/api/assistant/tasks", auto));
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.skillId).toBeNull();
    // The DB row, not just the response projection, has no skill.
    const persisted = db.prepare("SELECT skill_id FROM assistant_tasks WHERE id = ?").get(task.id) as { skill_id: string | null };
    expect(persisted.skill_id).toBeNull();
  });

  it("more than 5 images → 422 INVALID_ARGS cap message", async () => {
    const scoped = db.prepare("SELECT storage_key FROM attachments LIMIT 1").get() as { storage_key: string };
    const six = Array.from({ length: 6 }, () => ({
      storageKey: scoped.storage_key,
      mimeType: "image/png",
      name: "shot.png",
    }));
    const res = await handler(authed("POST", "/api/assistant/tasks", assistantTaskBody({ attachments: six })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(body.error.message).toContain("at most 5 images");
  });
});

// ADR-0005 W3: the document lane runs in-process over SSE — the create route
// only enqueues the row (the client POSTs /stream), cancel aborts the live
// stream or transitions the row directly, and resume runs the in-process
// continuation. No DO RPC on any of the three paths.
describe("POST /api/assistant/tasks — in-process SSE lane (no DO RPC)", () => {
  it("create returns 201 queued and never calls the DO enqueueRun RPC", async () => {
    let enqueueCalled = false;
    const threadRpc: AssistantThreadRpcShape = {
      available: true,
      getTranscript: async () => null,
      resumeBatch: async () => null,
      destroyThread: async () => null,
      resetThread: async () => null,
      enqueueRun: async () => {
        enqueueCalled = true;
        return { ok: false, reason: "deps_unavailable" };
      },
      abortRun: async () => null,
    };
    const doHandler = createAssistantApiHandler(dbPath, undefined, { threadRpc });

    const res = await doHandler(authed("POST", "/api/assistant/tasks", assistantTaskBody()));
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.status).toBe("queued");
    expect(enqueueCalled).toBe(false);
    const persisted = db.prepare("SELECT status FROM assistant_tasks WHERE id = ?").get(task.id) as { status: string };
    expect(persisted.status).toBe("queued");
  });

  it("cancel returns ok, lands the row cancelled, and never calls the DO abortRun RPC", async () => {
    let abortCalled = false;
    const threadRpc: AssistantThreadRpcShape = {
      available: true,
      getTranscript: async () => null,
      resumeBatch: async () => null,
      destroyThread: async () => null,
      resetThread: async () => null,
      enqueueRun: async () => null,
      abortRun: async () => {
        abortCalled = true;
        return null;
      },
    };
    const doHandler = createAssistantApiHandler(dbPath, undefined, { threadRpc });

    db.exec(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status)
       VALUES ('atc', 'p1', 'task', 't1', 'assistant', 'skill-t1', '', '', 'queued')`
    );
    const res = await doHandler(authed("POST", "/api/assistant/tasks/atc/cancel"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(abortCalled).toBe(false);
    const persisted = db.prepare("SELECT status FROM assistant_tasks WHERE id = 'atc'").get() as { status: string };
    expect(persisted.status).toBe("cancelled");
  });

  it("resume streams the in-process continuation and never calls the DO resumeBatch RPC", async () => {
    let resumeCalled = false;
    const threadRpc: AssistantThreadRpcShape = {
      available: true,
      getTranscript: async () => null,
      resumeBatch: async () => {
        resumeCalled = true;
        return null;
      },
      destroyThread: async () => null,
      resetThread: async () => null,
      enqueueRun: async () => null,
      abortRun: async () => null,
    };
    const doHandler = createAssistantApiHandler(dbPath, undefined, { threadRpc });

    // A thread whose batch is already claimed → the in-process lane settles
    // immediately with a terminal done frame, touching neither a provider nor
    // the DO.
    db.exec(`
INSERT OR REPLACE INTO assistant_providers (id, label, base_url, api_key) VALUES ('pv1', 'Test', 'https://model.test/v1', '');
INSERT OR REPLACE INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m1', 'pv1', 'test-model', 'openai_compatible', 0, 1);
INSERT OR REPLACE INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id) VALUES ('p1', '[]', 'pv1', 'm1');
INSERT OR REPLACE INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'assistant', 'skill-t1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"rb1","approvals":[]}}]');
INSERT OR REPLACE INTO assistant_resume_claims (batch_id) VALUES ('rb1');
`);
    const res = await doHandler(authed("POST", "/api/assistant/threads/task/t1/resume"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(resumeCalled).toBe(false);
  });
});

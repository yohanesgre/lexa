import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import type * as ProviderModule from "../assistant/provider";

// The route-level pin for the SSE task seam the panel depends on: only the
// single outbound model dispatch is stubbed, exactly like the service suite.
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    buildAdapter: () => ({}) as never,
    streamChat: () =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } };
      })(),
  };
});

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
INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pv1', 'Test', 'https://model.test/v1', '');
INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m1', 'pv1', 'test-model', 'openai_compatible', 0, 1);
INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id, primary_supports_images) VALUES ('p1', '[]', 'pv1', 'm1', 1);
`);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/assistant/tasks attachments", () => {
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

  it("refuses an unscoped storageKey (422 project-scope boundary) and more than 5 images (422 cap)", async () => {
    const unscoped = await handler(
      authed("POST", "/api/assistant/tasks", assistantTaskBody({
        attachments: [{ storageKey: "blobs/other-project-key", mimeType: "image/png", name: "sneaky.png" }],
      }))
    );
    expect(unscoped.status).toBe(422);
    const unscopedBody = await unscoped.json();
    expect(unscopedBody.error.code).toBe("INVALID_ARGS");
    expect(unscopedBody.error.message).toContain("does not belong to this project");

    const scoped = db.prepare("SELECT storage_key FROM attachments LIMIT 1").get() as { storage_key: string };
    const six = Array.from({ length: 6 }, () => ({
      storageKey: scoped.storage_key,
      mimeType: "image/png",
      name: "shot.png",
    }));
    const capped = await handler(authed("POST", "/api/assistant/tasks", assistantTaskBody({ attachments: six })));
    expect(capped.status).toBe(422);
    const cappedBody = await capped.json();
    expect(cappedBody.error.code).toBe("INVALID_ARGS");
    expect(cappedBody.error.message).toContain("at most 5 images");
  });
});

// ADR-0005 W3: the document lane runs in-process over SSE — the create route
// only enqueues the row (the client POSTs /stream) and cancel transitions the
// row directly. No DO RPC on either path.
describe("POST /api/assistant/tasks — in-process SSE lane (no DO RPC)", () => {
  it("create returns 201 queued and cancel lands the row cancelled", async () => {
    const res = await handler(authed("POST", "/api/assistant/tasks", assistantTaskBody()));
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.status).toBe("queued");
    const persisted = db.prepare("SELECT status FROM assistant_tasks WHERE id = ?").get(task.id) as { status: string };
    expect(persisted.status).toBe("queued");

    db.exec(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status)
       VALUES ('atc', 'p1', 'task', 't1', 'assistant', 'skill-t1', '', '', 'queued')`
    );
    const cancelled = await handler(authed("POST", "/api/assistant/tasks/atc/cancel"));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
    const persistedCancelled = db.prepare("SELECT status FROM assistant_tasks WHERE id = 'atc'").get() as { status: string };
    expect(persistedCancelled.status).toBe("cancelled");
  });

  it("streams the run to a terminal done frame and lands the task row completed", async () => {
    const created = await handler(authed("POST", "/api/assistant/tasks", assistantTaskBody()));
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; status: string };
    expect(task.status).toBe("queued");

    const res = await handler(authed("POST", `/api/assistant/tasks/${task.id}/stream`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: done");

    const row = db.prepare("SELECT status, result FROM assistant_tasks WHERE id = ?").get(task.id) as {
      status: string;
      result: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.result).toBe("ok");
  });
});

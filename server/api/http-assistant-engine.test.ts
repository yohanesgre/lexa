import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "d".repeat(43);

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

const authed = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: "p1",
    documentType: "task",
    documentId: "t1",
    prompt: "sharpen this",
    agentId: "assistant",
    skillId: "requirements",
    ...overrides,
  };
}

function setEngine(engine: "assistant" | "blacksmith") {
  db.exec(`UPDATE assistant_settings SET engine = '${engine}' WHERE project_id = 'p1'`);
}

function setRuntime(status: "online" | "offline") {
  db.exec(`UPDATE runtimes SET status = '${status}', last_seen = datetime('now') WHERE id = 'rt1'`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-engine-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'HE', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number) VALUES ('t1', 'p1', 'c1', 's-backlog', 'T1', 'a0', 'HE-1', 1);
INSERT INTO assistant_settings (project_id) VALUES ('p1');
INSERT INTO runtimes (id, name, provider, status) VALUES ('rt1', 'RT', 'opencode', 'offline');
INSERT INTO attachments (id, project_id, task_id, filename, mime_type, size_bytes, sha256, storage_key)
VALUES ('a1', 'p1', 't1', 'shot.png', 'image/png', 10, 'deadbeef', 'blobs/fake');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/assistant/tasks engine routing", () => {
  it("engine=assistant → kind='assistant' row, no runtime-online guard", async () => {
    setEngine("assistant");
    setRuntime("offline");
    const res = await handler(authed("POST", "/api/assistant/tasks", taskBody()));
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.kind).toBe("assistant");
  });

  it("engine=blacksmith + runtime online → kind='blacksmith' row with doc context", async () => {
    setEngine("blacksmith");
    setRuntime("online");
    const res = await handler(authed("POST", "/api/assistant/tasks", taskBody({ agentId: "blacksmith" })));
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.kind).toBe("blacksmith");
    const row = db.prepare("SELECT doc_context FROM runtime_tasks WHERE id = ?").get(task.id) as { doc_context: string };
    expect(row.doc_context).toContain("Task: HE-1");
  });

  it("engine=blacksmith + no online runtime → 409 NO_RUNTIME_ONLINE, no queue row", async () => {
    setEngine("blacksmith");
    setRuntime("offline");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE project_id = 'p1' AND kind = 'blacksmith'").get() as { n: number }).n;
    const res = await handler(authed("POST", "/api/assistant/tasks", taskBody({ agentId: "blacksmith" })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("NO_RUNTIME_ONLINE");
    const count = db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE project_id = 'p1' AND kind = 'blacksmith'").get() as { n: number };
    expect(count.n).toBe(before);
  });

  it("skill not junction-bound to the resolved engine's agent → 404 SKILL_NOT_FOUND", async () => {
    // polish is bound to assistant only — blacksmith lane must reject it.
    setEngine("blacksmith");
    setRuntime("online");
    const res = await handler(authed("POST", "/api/assistant/tasks", taskBody({ agentId: "blacksmith", skillId: "polish" })));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("SKILL_NOT_FOUND");
    // And the assistant lane accepts the same skill.
    setEngine("assistant");
    const ok = await handler(authed("POST", "/api/assistant/tasks", taskBody({ skillId: "polish" })));
    expect(ok.status).toBe(201);
  });
});

describe("POST /api/assistant/chat/stream engine guard", () => {
  it("engine=blacksmith → 409 ENGINE_NOT_SUPPORTED_FOR_CHAT before any stream/thread write", async () => {
    setEngine("blacksmith");
    setRuntime("online");
    const res = await handler(
      authed("POST", "/api/assistant/chat/stream", { projectId: "p1", chatId: "chat-1", message: "hello there" })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ENGINE_NOT_SUPPORTED_FOR_CHAT");
    const threads = db.prepare("SELECT COUNT(*) AS n FROM assistant_threads WHERE document_type = 'chat'").get() as { n: number };
    expect(threads.n).toBe(0);
  });

  it("engine=assistant passes the guard (stream proceeds to provider)", async () => {
    setEngine("assistant");
    const res = await handler(
      authed("POST", "/api/assistant/chat/stream", { projectId: "p1", chatId: "chat-2", message: "hello there" })
    );
    // The dead provider URL fails mid-stream (ASSISTANT_GENERATION_FAILED frame),
    // but the engine guard itself passed — no 409 envelope.
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("chat skillId must be junction-bound to assistant → else 404 SKILL_NOT_FOUND", async () => {
    setEngine("assistant");
    const res = await handler(
      authed("POST", "/api/assistant/chat/stream", {
        projectId: "p1",
        chatId: "chat-3",
        message: "hello",
        skillId: "no-such-binding",
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("SKILL_NOT_FOUND");
  });
});

describe("vision chain gating on POST /api/assistant/tasks", () => {
  it("attachments without any vision capability → 409 VISION_NOT_CONFIGURED, no queue row / thread write", async () => {
    setEngine("assistant");
    db.exec(`UPDATE assistant_settings SET primary_supports_images = 0 WHERE project_id = 'p1'`);
    const beforeTasks = (db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE project_id = 'p1'").get() as { n: number }).n;
    const beforeThreads = (db.prepare("SELECT COUNT(*) AS n FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { n: number }).n;
    const res = await handler(
      authed("POST", "/api/assistant/tasks", taskBody({
        attachments: [{ storageKey: "blobs/fake", mimeType: "image/png", name: "shot.png" }],
      }))
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("VISION_NOT_CONFIGURED");
    const tasks = db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE project_id = 'p1'").get() as { n: number };
    const threads = db.prepare("SELECT COUNT(*) AS n FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { n: number };
    expect(tasks.n).toBe(beforeTasks);
    expect(threads.n).toBe(beforeThreads);
  });

  it("primary_supports_images=1 → inline path accepted (201)", async () => {
    db.exec(`UPDATE assistant_settings SET primary_supports_images = 1 WHERE project_id = 'p1'`);
    const res = await handler(
      authed("POST", "/api/assistant/tasks", taskBody({
        attachments: [{ storageKey: "blobs/fake", mimeType: "image/png", name: "shot.png" }],
      }))
    );
    expect(res.status).toBe(201);
    await res.json();
  });

  it("vision_model removed → delegation unavailable, 409 VISION_NOT_CONFIGURED", async () => {
    db.exec(`UPDATE assistant_settings SET primary_supports_images = 0 WHERE project_id = 'p1'`);
    const res = await handler(
      authed("POST", "/api/assistant/tasks", taskBody({
        attachments: [{ storageKey: "blobs/fake", mimeType: "image/png", name: "shot.png" }],
      }))
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("VISION_NOT_CONFIGURED");
  });
});

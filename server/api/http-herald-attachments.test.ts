import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

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

function heraldTaskBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: "p1",
    documentType: "task",
    documentId: "t1",
    prompt: "describe the screenshot",
    agentId: "agent-t1",
    skillId: "skill-t1",
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-herald-attachments-api-"));
  const dbPath = join(dir, "test.db");
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
INSERT INTO lexa_agents (id, name, description, instructions) VALUES ('agent-t1', 'Test Agent', '', 'be helpful');
INSERT INTO lexa_skills (id, name, description, instructions) VALUES ('skill-t1', 'Describe image', '', 'look at the image');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/herald/settings/:projectId", () => {
  it("fresh project without apiKey → 422 INVALID_ARGS 'apiKey required on first save'", async () => {
    const res = await handler(
      authed("PUT", "/api/herald/settings/p1", {
        kind: "openai_compatible",
        baseUrl: "http://localhost:9/v1",
        model: "mock-mini",
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(body.error.message).toBe("apiKey required on first save");
  });

  it("with apiKey → masked view with hasKey true", async () => {
    const res = await handler(
      authed("PUT", "/api/herald/settings/p1", {
        kind: "openai_compatible",
        baseUrl: "http://localhost:9/v1",
        model: "mock-mini",
        apiKey: "sk-test-1234",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-test-1234");
  });
});

describe("POST /api/herald/tasks attachments", () => {
  it("unscoped storageKey → 422 INVALID_ARGS", async () => {
    const res = await handler(
      authed("POST", "/api/herald/tasks", heraldTaskBody({
        attachments: [{ storageKey: "blobs/other-project-key", mimeType: "image/png", name: "sneaky.png" }],
      }))
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(body.error.message).toContain("does not belong to this project");
  });

  it("scoped storageKey → 201 + image-ref part persisted in herald_threads", async () => {
    const up = await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", PNG_BYTES, "shot.png"));
    expect(up.status).toBe(201);
    const att = (await up.json()).data;
    const row = db.prepare("SELECT storage_key FROM attachments WHERE id = ?").get(att.id) as { storage_key: string };

    const res = await handler(
      authed("POST", "/api/herald/tasks", heraldTaskBody({
        attachments: [{ storageKey: row.storage_key, mimeType: "image/png", name: "shot.png" }],
      }))
    );
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.kind).toBe("herald");

    const thread = db
      .prepare("SELECT messages FROM herald_threads WHERE document_type = 'task' AND document_id = 't1'")
      .get() as { messages: string };
    const messages = JSON.parse(thread.messages) as Array<{ role: string; content: unknown[] }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toEqual([
      { type: "image-ref", storageKey: row.storage_key, mimeType: "image/png" },
    ]);
  });

  it("more than 5 images → 422 INVALID_ARGS cap message", async () => {
    const scoped = db.prepare("SELECT storage_key FROM attachments LIMIT 1").get() as { storage_key: string };
    const six = Array.from({ length: 6 }, () => ({
      storageKey: scoped.storage_key,
      mimeType: "image/png",
      name: "shot.png",
    }));
    const res = await handler(authed("POST", "/api/herald/tasks", heraldTaskBody({ attachments: six })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(body.error.message).toContain("at most 5 images");
  });
});

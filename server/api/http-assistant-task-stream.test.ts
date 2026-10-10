import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "d".repeat(43);

// The route-level pin for the SSE task seam the panel now depends on: create a
// queued task, POST /stream, and prove the in-process lane streams frames to a
// terminal `done` and lands the row `completed`. Only the model dispatch is
// stubbed (the single outbound call), exactly like the service suite.
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/provider")>();
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

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let dbPath: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

const authed = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-task-stream-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@lexa.test', 'A', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, position, created_at, key, number)
  VALUES ('t1', 'p1', 'c1', 's-backlog', 'Fix login', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The login button is broken."}]}]}', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'Test Agent', '', 'Be precise.', 0);
INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'Test Polish', '', 'Polish the text.', 0);
INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('a1', 'sk1');
INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pv1', 'Test', 'https://model.test/v1', '');
INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m1', 'pv1', 'test-model', 'openai_compatible', 0, 1);
INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id) VALUES ('p1', '[]', 'pv1', 'm1');
`);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/assistant/tasks/:id/stream — in-process SSE lane", () => {
  it("streams the run to a terminal done frame and lands the task row completed", async () => {
    const created = await handler(
      authed("POST", "/api/assistant/tasks", {
        slug: "p1",
        documentType: "task",
        documentId: "t1",
        prompt: "improve this doc",
        agentId: "a1",
        skillId: "sk1",
      })
    );
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

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-activity-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Default', 0);
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a0', '2026-01-01 10:00:00');
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at) VALUES ('t1', 'user', 'Maria', 'u1', 'created', 'Maria created this task', '2026-01-01 10:00:00');
INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, created_at) VALUES ('t1', 'u1', 'user', 'Maria', '{"type":"doc","content":[]}', '2026-01-02 10:00:00');
`);
  db.close();
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/projects/:slug/tasks/:id/activity", () => {
  it("returns merged timeline with cursor", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1", {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(["event", "comment"]).toContain(body.data[0].kind);
    expect(body.nextCursor).toBeTruthy();
  });

  it("pages through the whole timeline with the cursor", async () => {
    const page1 = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1", {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    const body1 = await page1.json();
    expect(body1.data).toHaveLength(1);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await handler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1&cursor=${encodeURIComponent(body1.nextCursor)}`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    const body2 = await page2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
    // ascending order across pages: page1 newest, page2 oldest
    expect(body1.data[0].createdAt > body2.data[0].createdAt).toBe(true);
  });

  it("rejects without a key", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/activity"));
    expect(res.status).toBe(401);
  });

  it("404s for an unknown project", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/nope/tasks/t1/activity", {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    expect(res.status).toBe(404);
  });

  it("updateTask response carries the appended activity", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1", {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }));
    expect(res.status).toBe(200);
    const { data, activity } = await res.json();
    expect(data.title).toBe("New title");
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe("field_changed");
    expect(activity[0].message).toBe("Maria changed the title");
    expect(activity[0].kind).toBe("event");
  });

  it("moveTask response carries the appended activity", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/move", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ columnId: "c1", swimlaneId: "s1" }),
    }));
    expect(res.status).toBe(200);
    const { data, activity } = await res.json();
    expect(data.title).toBe("New title");
    // no-op move (same column/lane, no neighbors) → no activity rows
    expect(activity).toEqual([]);
  });
});

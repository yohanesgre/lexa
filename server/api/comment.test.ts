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

const BODY = JSON.stringify({ body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } });
const EMPTY_BODY = JSON.stringify({ body: { type: "doc", content: [] } });
const headers = (email: string) => ({
  authorization: `Bearer ${ADMIN_KEY}`,
  "x-lxk-user": email,
  "content-type": "application/json",
});

let dir: string;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-comment-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Default', 0);
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member'), ('u2', 'alex@lexa.test', 'Alex', 'member');
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2', 'admin', 'p1');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a0', '2026-01-01 10:00:00');
`);
  db.close();
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("comment endpoints", () => {
  it("create → 201 with comment + activity; invalid body → 422", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.comment.authorLabel).toBe("Maria");
    expect(data.comment.body).toEqual(JSON.parse(BODY).body);
    expect(data.activity.type).toBe("commented");
    expect(data.activity.message).toBe("Maria commented");

    const invalid = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: EMPTY_BODY,
    }));
    expect(invalid.status).toBe(422);
    const errBody = await invalid.json();
    expect(errBody.error.code).toBe("COMMENT_INVALID");
  });

  it("create on an unknown task → 404 TASK_NOT_FOUND", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/nope/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("TASK_NOT_FOUND");
  });

  it("edit by non-author → 403 COMMENT_EDIT_FORBIDDEN", async () => {
    const created = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    const { data } = await created.json();
    const res = await handler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data.comment.id}`, {
      method: "PATCH",
      headers: headers("alex@lexa.test"),
      body: BODY,
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("COMMENT_EDIT_FORBIDDEN");
  });

  it("edit by author → 200 with editedAt set", async () => {
    const created = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    const { data } = await created.json();
    const res = await handler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data.comment.id}`, {
      method: "PATCH",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.editedAt).not.toBeNull();
  });

  it("delete by author → 204; delete by admin non-author → 204", async () => {
    const created = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    const { data } = await created.json();
    const asAuthor = await handler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data.comment.id}`, {
      method: "DELETE",
      headers: headers("maria@lexa.test"),
    }));
    expect(asAuthor.status).toBe(204);

    const created2 = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: headers("maria@lexa.test"),
      body: BODY,
    }));
    const { data: data2 } = await created2.json();
    const asAdmin = await handler(new Request(`http://lexa.test/api/projects/p1/tasks/t1/comments/${data2.comment.id}`, {
      method: "DELETE",
      headers: headers("alex@lexa.test"),
    }));
    expect(asAdmin.status).toBe(204);
  });
});

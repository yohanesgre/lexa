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
const MEMBER_KEY = "lxk_" + "b".repeat(43);

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

const authed = (method: string, path: string, body?: unknown, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const pub = (path: string) => new Request(`http://lexa.test${path}`);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mentions-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'bob@lexa.test', 'Bob', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u2');
-- p1: mention search fixtures.
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 3);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1', 'p1', 'c1', 's-backlog', 'Onboarding flow', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2', 'p1', 'c1', 's-backlog', 'Payment retry logic', 'a1', '2026-01-01 10:00:00', 'EG-2', 2);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, archived_at, created_at, key, number) VALUES ('t-arch', 'p1', 'c2', 's-backlog', 'Onboarding archived', 'a0', '2026-02-01 10:00:00', '2026-01-01 10:00:00', 'EG-9', 9);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Roadmap', 'roadmap', '{"type":"doc","content":[]}', '', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w2', 'p1', 'Unrelated page', 'unrelated', '{"type":"doc","content":[]}', '', 1);
-- Cap fixtures: 5 tasks + 5 wiki pages all matching q=capfill (11th would-be hit proves the cap).
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t1', 'p1', 'c1', 's-backlog', 'Capfill one', 'b0', '2026-01-01 10:00:00', 'CF-1', 11);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t2', 'p1', 'c1', 's-backlog', 'Capfill two', 'b1', '2026-01-01 10:00:00', 'CF-2', 12);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t3', 'p1', 'c1', 's-backlog', 'Capfill three', 'b2', '2026-01-01 10:00:00', 'CF-3', 13);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t4', 'p1', 'c1', 's-backlog', 'Capfill four', 'b3', '2026-01-01 10:00:00', 'CF-4', 14);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('cap-t5', 'p1', 'c1', 's-backlog', 'Capfill five', 'b4', '2026-01-01 10:00:00', 'CF-5', 15);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w1', 'p1', 'Capfill w1', 'capfill-w1', '{"type":"doc","content":[]}', '', 2);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w2', 'p1', 'Capfill w2', 'capfill-w2', '{"type":"doc","content":[]}', '', 3);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w3', 'p1', 'Capfill w3', 'capfill-w3', '{"type":"doc","content":[]}', '', 4);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w4', 'p1', 'Capfill w4', 'capfill-w4', '{"type":"doc","content":[]}', '', 5);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('cap-w5', 'p1', 'Capfill w5', 'capfill-w5', '{"type":"doc","content":[]}', '', 6);
-- Second project: its rows must never leak into p1 results.
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p2', 'Q', 'p2', 'ZZ', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c2-1', 'p2', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s2-backlog', 'p2', 'Backlog', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2-zz', 'p2', 'c2-1', 's2-backlog', 'Onboarding elsewhere', 'a0', '2026-01-01 10:00:00', 'ZZ-1', 1);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w2-zz', 'p2', 'Roadmap elsewhere', 'roadmap-elsewhere', '{"type":"doc","content":[]}', '', 0);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/projects/:slug/mentions", () => {
  it("empty q → empty arrays", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q="));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { tasks: [], wikiPages: [] } });
  });

  it("matches a task by key case-insensitively", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q=eg-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { tasks: [{ id: "t1", key: "EG-1", title: "Onboarding flow" }], wikiPages: [] },
    });
  });

  it("matches a task by title substring", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q=payment"));
    expect((await res.json()).data.tasks).toEqual([{ id: "t2", key: "EG-2", title: "Payment retry logic" }]);
  });

  it("matches a wiki page by title and by slug substring", async () => {
    const byTitle = await handler(authed("GET", "/api/projects/p1/mentions?q=road"));
    expect((await byTitle.json()).data.wikiPages).toEqual([{ id: "w1", slug: "roadmap", title: "Roadmap" }]);
    const bySlug = await handler(authed("GET", "/api/projects/p1/mentions?q=unrel"));
    expect((await bySlug.json()).data.wikiPages).toEqual([{ id: "w2", slug: "unrelated", title: "Unrelated page" }]);
  });

  it("excludes archived tasks even when they match", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q=onboarding"));
    const body = await res.json();
    // t1 matches by title; t-arch ("Onboarding archived") must not appear.
    expect(body.data.tasks.map((t: { id: string }) => t.id)).toEqual(["t1"]);
  });

  it("caps the combined result at 8 with tasks filled first", async () => {
    // 5 tasks + 5 wiki pages match q=capfill; only 3 wiki slots remain after tasks.
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q=capfill"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasks.map((t: { id: string }) => t.id)).toEqual(["cap-t1", "cap-t2", "cap-t3", "cap-t4", "cap-t5"]);
    expect(body.data.wikiPages.map((w: { id: string }) => w.id)).toEqual(["cap-w1", "cap-w2", "cap-w3"]);
    expect(body.data.tasks.length + body.data.wikiPages.length).toBeLessThanOrEqual(8);
  });

  it("never leaks rows from another project (both directions)", async () => {
    const p1 = await handler(authed("GET", "/api/projects/p1/mentions?q=onboarding"));
    const p1Body = await p1.json();
    expect(p1Body.data.tasks.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    expect(JSON.stringify(p1Body)).not.toContain("t2-zz");
    expect(JSON.stringify(p1Body)).not.toContain("w2-zz");

    const p2 = await handler(authed("GET", "/api/projects/p2/mentions?q=onboarding"));
    const p2Body = await p2.json();
    expect(p2Body.data.tasks.map((t: { id: string }) => t.id)).toEqual(["t2-zz"]);
    expect(JSON.stringify(p2Body)).not.toContain('"t1"');

    const roadmapP2 = await handler(authed("GET", "/api/projects/p2/mentions?q=roadmap"));
    expect((await roadmapP2.json()).data.wikiPages).toEqual([{ id: "w2-zz", slug: "roadmap-elsewhere", title: "Roadmap elsewhere" }]);
  });

  it("rejects without a key → 401", async () => {
    const res = await handler(pub("/api/projects/p1/mentions?q=eg"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("member-bound key → 403 FORBIDDEN at the middleware (consistent with sibling project routes)", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/mentions?q=eg", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
});

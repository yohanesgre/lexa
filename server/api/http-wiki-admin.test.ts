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
const MEMBER_KEY = "lxk_" + "m".repeat(43);

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-admin-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member'), ('u3', 'pam@lexa.test', 'Pam', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u3');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', 'hello world', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES ('w2', 'p1', 'Child', 'child', '{"type":"doc","content":[]}', '', 'w1', 0);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("wiki routes", () => {
  it("GET /api/projects/:slug/wiki lists pages", async () => {
    const res = await handler(json("GET", "/api/projects/p1/wiki"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((p: { slug: string }) => p.slug)).toEqual(["home", "child"]);
    expect(body.data[0]!.hasChildren).toBe(true);
  });

  it("POST /api/projects/:slug/wiki creates a page (201); unknown project → 404", async () => {
    const ok = await handler(json("POST", "/api/projects/p1/wiki", { title: "New Page", slug: "new-page" }));
    expect(ok.status).toBe(201);
    const page = await ok.json();
    expect(page).toMatchObject({ title: "New Page", slug: "new-page", projectId: "p1" });
    const missing = await handler(json("POST", "/api/projects/nope/wiki", { title: "X" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("POST with a duplicate slug → 409 SLUG_TAKEN (UNIQUE(project_id, slug))", async () => {
    const res = await handler(json("POST", "/api/projects/p1/wiki", { title: "Home Again", slug: "home" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SLUG_TAKEN");
  });

  it("GET /api/projects/:slug/wiki/:pageSlug returns the page; unknown → 404 PAGE_NOT_FOUND", async () => {
    const ok = await handler(json("GET", "/api/projects/p1/wiki/home"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).slug).toBe("home");
    const missing = await handler(json("GET", "/api/projects/p1/wiki/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PAGE_NOT_FOUND");
  });

  it("GET /api/projects/:slug/wiki/:pageSlug/children lists child pages", async () => {
    const res = await handler(json("GET", "/api/projects/p1/wiki/home/children"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((p: { slug: string }) => p.slug)).toEqual(["child"]);
  });

  it("PATCH /api/projects/:slug/wiki/:pageSlug updates the title", async () => {
    const res = await handler(json("PATCH", "/api/projects/p1/wiki/home", { title: "Home Renamed" }));
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Home Renamed");
  });

  it("DELETE a page with children → 409 HAS_CHILDREN; a leaf → 204", async () => {
    const blocked = await handler(json("DELETE", "/api/projects/p1/wiki/home"));
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe("HAS_CHILDREN");
    expect(body.error.details.count).toBeGreaterThan(0);
    const created = await handler(json("POST", "/api/projects/p1/wiki", { title: "Leaf", slug: "leaf" }));
    const { slug } = await created.json();
    const del = await handler(json("DELETE", `/api/projects/p1/wiki/${slug}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });

  it("GET /api/projects/:slug/wiki/search finds FTS hits with a snippet", async () => {
    const res = await handler(json("GET", "/api/projects/p1/wiki/search?q=hello"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]!.slug).toBe("home");
    expect(body.data[0]!.snippet).toContain("hello");
  });

  it("GET wiki/search with a missing q → 200 empty data", async () => {
    const res = await handler(json("GET", "/api/projects/p1/wiki/search"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("GET wiki/search with invalid FTS5 syntax → 422 SEARCH_ERROR", async () => {
    const res = await handler(json("GET", "/api/projects/p1/wiki/search?q=%22unbalanced"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("SEARCH_ERROR");
  });
});

describe("settings api-keys routes", () => {
  it("GET /api/settings/api-keys lists keys without hashes", async () => {
    const res = await handler(json("GET", "/api/settings/api-keys"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.some((k: { id: string }) => k.id === "k1")).toBe(true);
    expect("keyHash" in body.data[0]!).toBe(false);
    expect("key_hash" in body.data[0]!).toBe(false);
  });

  it("POST /api/settings/api-keys returns the raw key once (201); the key works", async () => {
    const res = await handler(json("POST", "/api/settings/api-keys", { name: "ops" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key.name).toBe("ops");
    expect(body.rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    // The freshly minted raw key authenticates.
    const health = await handler(new Request("http://lexa.test/api/health", {
      headers: { authorization: `Bearer ${body.rawKey}` },
    }));
    expect(health.status).toBe(200);
  });

  it("DELETE /api/settings/api-keys/:id → 204; the deleted key stops working", async () => {
    const created = await handler(json("POST", "/api/settings/api-keys", { name: "temp" }));
    const { key, rawKey } = await created.json();
    const del = await handler(json("DELETE", `/api/settings/api-keys/${key.id}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const res = await handler(new Request("http://lexa.test/api/projects", {
      headers: { authorization: `Bearer ${rawKey}` },
    }));
    expect(res.status).toBe(401);
  });

  it("member-bound key → 403 FORBIDDEN on api-key routes", async () => {
    const res = await handler(json("GET", "/api/settings/api-keys", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
});

describe("admin gate", () => {
  it("GET /api/admin/users works for the admin key", async () => {
    const res = await handler(json("GET", "/api/admin/users"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.some((u: { email: string }) => u.email === "maria@lexa.test")).toBe(true);
  });

  it("member-bound key → 403 FORBIDDEN on admin routes", async () => {
    const res = await handler(json("GET", "/api/admin/users", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
});

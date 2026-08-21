import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { PUBLIC_URL } from "../auth";

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
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-share-api-"));
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
INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', 'hello world', 0);
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

describe("wiki share-link routes", () => {
  it("POST /api/projects/:slug/wiki/pages/:pageSlug/share with {} → 201 link without token", async () => {
    const res = await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link).toMatchObject({
      id: expect.any(String),
      url: expect.any(String),
      expiresAt: null,
      createdAt: expect.any(String),
    });
    expect(body.link.url.startsWith(`${PUBLIC_URL}/share/`)).toBe(true);
    expect(body.link.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("POST with expiresAt echoes it normalized", async () => {
    const res = await handler(
      json("POST", "/api/projects/p1/wiki/pages/home/share", { expiresAt: "2026-09-30T00:00:00.000Z" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link.expiresAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it("POST with malformed expiresAt → 4xx validation error, not 500", async () => {
    const res = await handler(
      json("POST", "/api/projects/p1/wiki/pages/home/share", { expiresAt: "garbage" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("POST with a member-bound key → 403 FORBIDDEN (middleware rejects member keys)", async () => {
    const res = await handler(json("POST", "/api/projects/p2/wiki/pages/home/share", {}, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("GET /api/projects/:slug/wiki/pages/:pageSlug/share lists created links", async () => {
    const listRes = await handler(json("GET", "/api/projects/p1/wiki/pages/home/share"));
    const before = ((await listRes.json()) as { data: unknown[] }).data.length;
    await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    const res = await handler(json("GET", "/api/projects/p1/wiki/pages/home/share"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(before + 2);
    for (const link of body.data) {
      expect(link.url.startsWith(`${PUBLIC_URL}/share/`)).toBe(true);
      expect(link.token).toBeUndefined();
    }
  });

  it("DELETE /api/projects/:slug/wiki/share/:linkId → 204", async () => {
    const created = await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    const { link } = await created.json();
    const del = await handler(json("DELETE", `/api/projects/p1/wiki/share/${link.id}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });

  it("DELETE an unknown link id → 404 SHARE_LINK_NOT_FOUND", async () => {
    const res = await handler(json("DELETE", "/api/projects/p1/wiki/share/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
  });
});

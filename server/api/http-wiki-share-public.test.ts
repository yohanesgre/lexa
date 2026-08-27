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

// NO authorization header — the whole point of this surface.
const pub = (path: string) => new Request(`http://lexa.test${path}`);

async function createLink(expiresAt?: string): Promise<{ id: string; token: string }> {
  const res = await handler(authed("POST", "/api/projects/p1/wiki/pages/home/share", expiresAt ? { expiresAt } : {}));
  expect(res.status).toBe(201);
  const body = await res.json();
  // url = `${PUBLIC_URL}/share/${token}` — recover the token from the URL.
  const token = (body.link.url as string).split("/share/")[1]!;
  return { id: body.link.id, token };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-share-public-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', 'hello world', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, parent_id, content, content_text, position) VALUES ('w2', 'p1', 'Child', 'child', 'w1', '{"type":"doc","content":[]}', 'child page', 0);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("public GET /api/share/:token", () => {
  it("valid token → 200 root + descendant subtree without auth", async () => {
    const { token } = await createLink();
    const res = await handler(pub(`/api/share/${token}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toMatchObject({ id: "w1", title: "Home", slug: "home" });
    expect(body.root.content).toEqual({ type: "doc", content: [] });
    const child = (body.root.children as Array<Record<string, unknown>>).find((c) => c.id === "w2");
    expect(child).toMatchObject({ title: "Child", slug: "child" });
  });

  it("unknown token → 404 SHARE_LINK_NOT_FOUND", async () => {
    const res = await handler(pub("/api/share/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
  });

  it("expired token → identical generic 404 as unknown (no oracle)", async () => {
    const { token } = await createLink("2020-01-01T00:00:00.000Z");
    const expired = await handler(pub(`/api/share/${token}`));
    const unknown = await handler(pub("/api/share/nope"));
    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    const e = await expired.json();
    const u = await unknown.json();
    expect(e.error.code).toBe(u.error.code);
    expect(e.error.code).toBe("SHARE_LINK_NOT_FOUND");
  });

  it("revoked token → identical generic 404 as unknown (no oracle)", async () => {
    const { id, token } = await createLink();
    const del = await handler(authed("DELETE", `/api/projects/p1/wiki/share/${id}`));
    expect(del.status).toBe(204);
    const revoked = await handler(pub(`/api/share/${token}`));
    expect(revoked.status).toBe(404);
    expect((await revoked.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
  });

  it("burst beyond the dedicated share bucket → 429 RATE_LIMITED", async () => {
    let saw429 = false;
    for (let i = 0; i < 45; i++) {
      const res = await handler(pub("/api/share/nope"));
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(saw429).toBe(true);
  });
});

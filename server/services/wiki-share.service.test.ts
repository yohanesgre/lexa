import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { WikiShareService } from "./wiki-share.service";
import { ShareLinkNotFound, WikiPageNotFound } from "../api/errors";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

const ROOT_DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "root text" }] }],
};

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-wiki-share-svc-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function seed(db: Database) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'u1@test.dev', 'User One')").run();
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
  db.prepare(
    `INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES
       ('w-root', 'p1', 'Root', 'root', ?, 'root text', NULL, 0),
       ('w-child', 'p1', 'Child', 'child', '{}', '', 'w-root', 0),
       ('w-other', 'p2', 'Other', 'other', '{}', '', NULL, 0)`
  ).run(JSON.stringify(ROOT_DOC));
}

function makeService(db: Database) {
  const layer = WikiShareService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WikiShareService);
}

function createLink(
  svc: WikiShareService,
  overrides: Partial<{ projectId: string; pageId: string; expiresAt: string | null; createdBy: string }> = {}
) {
  return Effect.runSync(
    Effect.either(
      svc.create({
        projectId: "p1",
        pageId: "w-root",
        expiresAt: null,
        createdBy: "u1",
        ...overrides,
      })
    )
  );
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("WikiShareService.create", () => {
  it("creates a link with a base64url token, uuid id, and NULL expiry preserved", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = createLink(svc);
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(res.right.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.right.page_id).toBe("w-root");
      expect(res.right.created_by).toBe("u1");
      expect(res.right.expires_at).toBeNull();
    }
  });

  it("normalizes expiresAt to UTC ISO-8601", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = createLink(svc, { expiresAt: "2026-09-01T15:00:00+03:00" });
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) expect(res.right.expires_at).toBe("2026-09-01T12:00:00.000Z");
  });

  it("page of another project → WikiPageNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = createLink(svc, { projectId: "p1", pageId: "w-other" });
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });

  it("unknown page → WikiPageNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = createLink(svc, { pageId: "nope" });
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });
});

describe("WikiShareService.list", () => {
  it("lists links for a page, oldest first; other pages unaffected", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const a = createLink(svc);
    const b = createLink(svc);
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true);
    if (!Either.isRight(a) || !Either.isRight(b)) throw new Error("create failed");
    const links = Effect.runSync(svc.list("w-root"));
    // ORDER BY created_at ASC, id ASC — same-second inserts tie-break on id
    const expected = [a.right, b.right]
      .map((r) => ({ token: r.token, created_at: r.created_at, id: r.id }))
      .sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))
      .map((r) => r.token);
    expect(links.map((l) => l.token)).toEqual(expected);
    expect(Effect.runSync(svc.list("w-child"))).toEqual([]);
  });
});

describe("WikiShareService.revoke", () => {
  it("deletes the link; resolving it afterwards fails ShareLinkNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const created = createLink(svc);
    if (!Either.isRight(created)) throw new Error("create failed");
    const revoked = Effect.runSync(Effect.either(svc.revoke(created.right.id, "p1")));
    expect(Either.isRight(revoked)).toBe(true);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_share_links WHERE id = ?").get(created.right.id) as { n: number }).n;
    expect(n).toBe(0);
    const resolved = Effect.runSync(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isLeft(resolved)).toBe(true);
    if (Either.isLeft(resolved)) expect(resolved.left).toBeInstanceOf(ShareLinkNotFound);
  });

  it("missing id → ShareLinkNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.revoke("nope", "p1")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ShareLinkNotFound);
  });
});

describe("WikiShareService.resolvePublic", () => {
  it("valid token returns root + descendants with parsed JSON content", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const created = createLink(svc);
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = Effect.runSync(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      const root = res.right.root;
      expect(root.id).toBe("w-root");
      expect(root.title).toBe("Root");
      expect(root.slug).toBe("root");
      expect(typeof root.updatedAt).toBe("string");
      expect(root.content).toEqual(ROOT_DOC);
      expect(root.children).toHaveLength(1);
      expect(root.children[0]!.id).toBe("w-child");
      expect(root.children[0]!.content).toEqual({});
      expect(root.children[0]!.children).toEqual([]);
    }
  });

  it("expired link → ShareLinkNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const created = createLink(svc, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = Effect.runSync(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ShareLinkNotFound);
  });

  it("future expiry still resolves", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const created = createLink(svc, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = Effect.runSync(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isRight(res)).toBe(true);
  });

  it("NULL expiry never expires", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const created = createLink(svc);
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = Effect.runSync(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isRight(res)).toBe(true);
  });

  it("unknown token → ShareLinkNotFound (same failure path)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.resolvePublic("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ShareLinkNotFound);
  });
});

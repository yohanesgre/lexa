import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { WikiService } from "./wiki.service";
import { WikiShareService } from "./wiki-share.service";
import { ShareLinkNotFound, WikiPageNotFound, SlugTaken, HasChildren, InvalidParent } from "../api/errors";
import type { TipTapDoc } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-svc-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});


const DOC: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] };

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
}

function makeService(db: Database) {
  const layer = WikiService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WikiService);
}

describe("WikiService.create", () => {
  it("slug uniqueness is per project — same slug in another project is fine", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(Effect.either(svc.create("p1", { title: "Home" })));
    const dup = await Effect.runPromise(Effect.either(svc.create("p1", { title: "Home" })));
    expect(Either.isLeft(dup)).toBe(true);
    if (Either.isLeft(dup)) expect(dup.left).toBeInstanceOf(SlugTaken);
    const other = await Effect.runPromise(Effect.either(svc.create("p2", { title: "Home" })));
    expect(Either.isRight(other)).toBe(true);
    if (Either.isRight(other)) expect(other.right.slug).toBe("home");
  });
});
describe("WikiService.update", () => {
  it("self-parent → InvalidParent(self), page unchanged", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "P" }));
    const res = await Effect.runPromise(Effect.either(svc.update(page.id, { parentId: page.id })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(InvalidParent);
      if (res.left instanceof InvalidParent) expect(res.left.reason).toBe("self");
    }
    const raw = db.prepare("SELECT parent_id FROM wiki_pages WHERE id = ?").get(page.id) as { parent_id: string | null };
    expect(raw.parent_id).toBeNull();
  });

  it("direct cycle (parent under its own child) → InvalidParent(cycle), unchanged", async () => {
    seed(db);
    const svc = makeService(db);
    const a = await Effect.runPromise(svc.create("p1", { title: "A" }));
    const b = await Effect.runPromise(svc.create("p1", { title: "B", parentId: a.id }));
    const res = await Effect.runPromise(Effect.either(svc.update(a.id, { parentId: b.id })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(InvalidParent);
      if (res.left instanceof InvalidParent) expect(res.left.reason).toBe("cycle");
    }
    const raw = db.prepare("SELECT parent_id FROM wiki_pages WHERE id = ?").get(a.id) as { parent_id: string | null };
    expect(raw.parent_id).toBeNull();
  });

  it("cross-project parent → InvalidParent(cross-project)", async () => {
    seed(db);
    const svc = makeService(db);
    const a = await Effect.runPromise(svc.create("p1", { title: "A" }));
    const other = await Effect.runPromise(svc.create("p2", { title: "Other" }));
    const res = await Effect.runPromise(Effect.either(svc.update(a.id, { parentId: other.id })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(InvalidParent);
      if (res.left instanceof InvalidParent) expect(res.left.reason).toBe("cross-project");
    }
  });
});

describe("WikiService revisions", () => {
  it("listRevisions returns newest-first summaries with saveType; getRevision returns full revision", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "P", content: DOC, contentText: "hello" }));
    await Effect.runPromise(svc.update(page.id, { title: "P2" }, "manual"));
    const summaries = await Effect.runPromise(svc.listRevisions("p", "p1"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.saveType).toBe("manual");
    expect(summaries[0]!.title).toBe("P");
    const full = await Effect.runPromise(Effect.either(svc.getRevision(summaries[0]!.id)));
    expect(Either.isRight(full)).toBe(true);
    if (Either.isRight(full)) {
      expect(full.right.pageId).toBe(page.id);
      // revisions snapshot the plain-text projection derived from the content
      expect(full.right.contentText).toBe("hello");
      expect(full.right.content).toEqual(DOC);
    }
  });

  it("restores an earlier revision (and rejects a revision owned by another page)", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "Guide", content: DOC, contentText: "old text" }));
    const other = await Effect.runPromise(svc.create("p1", { title: "Other" }));
    await Effect.runPromise(svc.update(page.id, { title: "Guide 2", contentText: "new text" }));
    await Effect.runPromise(svc.update(other.id, { title: "Other 2" }));

    const [rev] = await Effect.runPromise(svc.listRevisions("guide", "p1"));
    const restored = await Effect.runPromise(Effect.either(svc.restoreRevision(rev!.id, "guide", "p1")));
    expect(Either.isRight(restored)).toBe(true);
    if (Either.isRight(restored)) {
      expect(restored.right.title).toBe("Guide");
      expect(restored.right.content).toEqual(DOC);
    }
    const rows = db.prepare("SELECT save_type FROM wiki_page_revisions WHERE page_id = ?").all(page.id) as { save_type: string }[];
    expect(rows.map((r) => r.save_type).sort()).toEqual(["autosave", "manual"]);

    const [otherRev] = await Effect.runPromise(svc.listRevisions("other", "p1"));
    const bad = await Effect.runPromise(Effect.either(svc.restoreRevision(otherRev!.id, "guide", "p1")));
    expect(Either.isLeft(bad)).toBe(true);
    if (Either.isLeft(bad)) expect(bad.left).toBeInstanceOf(WikiPageNotFound);
  });
});

describe("WikiService.delete", () => {
  it("deletes a leaf page and its revisions", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "Leaf" }));
    await Effect.runPromise(svc.update(page.id, { title: "Leaf 2" }));
    const res = await Effect.runPromise(Effect.either(svc.delete(page.id)));
    expect(Either.isRight(res)).toBe(true);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE id = ?").get(page.id) as { n: number }).n;
    expect(n).toBe(0);
    const revs = (db.prepare("SELECT COUNT(*) AS n FROM wiki_page_revisions WHERE page_id = ?").get(page.id) as { n: number }).n;
    expect(revs).toBe(0);
  });

  it("page with children → HasChildren with the child count", async () => {
    seed(db);
    const svc = makeService(db);
    const parent = await Effect.runPromise(svc.create("p1", { title: "Parent" }));
    await Effect.runPromise(svc.create("p1", { title: "Child", parentId: parent.id }));
    const res = await Effect.runPromise(Effect.either(svc.delete(parent.id)));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(HasChildren);
      if (res.left instanceof HasChildren) expect(res.left.count).toBe(1);
    }
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE id = ?").get(parent.id) as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("WikiService.search", () => {
  it("FTS5 finds pages by contentText with a snippet", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "Indexing", content: DOC, contentText: "fractional indexing keeps keys short" }));
    const results = await Effect.runPromise(Effect.either(svc.search("p1", "fractional")));
    expect(Either.isRight(results)).toBe(true);
    if (Either.isRight(results)) {
      expect(results.right).toHaveLength(1);
      expect(results.right[0]!.id).toBe(page.id);
      expect(results.right[0]!.snippet).toContain("fractional");
    }
  });
});

// ── wiki share service (absorbed from wiki-share.service.test.ts) ──────────
const ROOT_DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "root text" }] }],
};

function seedShare(db: Database) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'u1@test.dev', 'User One')").run();
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
  const emptyDoc = JSON.stringify({ type: "doc", content: [] });
  db.prepare(
    `INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES
       ('w-root', 'p1', 'Root', 'root', ?, 'root text', NULL, 0),
       ('w-child', 'p1', 'Child', 'child', ?, '', 'w-root', 0),
       ('w-other', 'p2', 'Other', 'other', ?, '', NULL, 0)`
  ).run(JSON.stringify(ROOT_DOC), emptyDoc, emptyDoc);
}

function makeShareService(db: Database) {
  const layer = WikiShareService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WikiShareService);
}

async function createLink(
  svc: WikiShareService,
  overrides: Partial<{ projectId: string; pageId: string; expiresAt: string | null; createdBy: string }> = {}
) {
  return await Effect.runPromise(
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

describe("WikiShareService.create", () => {
  it("creates a link with a base64url token, uuid id, and NULL expiry preserved", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const res = await createLink(svc);
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(res.right.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.right.page_id).toBe("w-root");
      expect(res.right.created_by).toBe("u1");
      expect(res.right.expires_at).toBeNull();
    }
  });

  it("page of another project → WikiPageNotFound", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const res = await createLink(svc, { projectId: "p1", pageId: "w-other" });
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });

  it("unknown page → WikiPageNotFound", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const res = await createLink(svc, { pageId: "nope" });
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });
});

describe("WikiShareService.list", () => {
  it("lists links for a page, oldest first; other pages unaffected", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const a = await createLink(svc);
    const b = await createLink(svc);
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true);
    if (!Either.isRight(a) || !Either.isRight(b)) throw new Error("create failed");
    const links = await Effect.runPromise(svc.list("w-root"));
    // ORDER BY created_at ASC, id ASC — same-second inserts tie-break on id
    const expected = [a.right, b.right]
      .map((r) => ({ token: r.token, created_at: r.created_at, id: r.id }))
      .sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))
      .map((r) => r.token);
    expect(links.map((l) => l.token)).toEqual(expected);
    expect(await Effect.runPromise(svc.list("w-child"))).toEqual([]);
  });
});

describe("WikiShareService.revoke", () => {
  it("deletes the link; resolving it afterwards fails ShareLinkNotFound", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const created = await createLink(svc);
    if (!Either.isRight(created)) throw new Error("create failed");
    const revoked = await Effect.runPromise(Effect.either(svc.revoke(created.right.id, "p1")));
    expect(Either.isRight(revoked)).toBe(true);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_share_links WHERE id = ?").get(created.right.id) as { n: number }).n;
    expect(n).toBe(0);
    const resolved = await Effect.runPromise(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isLeft(resolved)).toBe(true);
    if (Either.isLeft(resolved)) expect(resolved.left).toBeInstanceOf(ShareLinkNotFound);
  });
});

describe("WikiShareService.resolvePublic", () => {
  it("valid token returns root + descendants with parsed JSON content", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const created = await createLink(svc);
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = await Effect.runPromise(Effect.either(svc.resolvePublic(created.right.token)));
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
      expect(root.children[0]!.content).toEqual({ type: "doc", content: [] });
      expect(root.children[0]!.children).toEqual([]);
    }
  });

  it("expired link → ShareLinkNotFound", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const created = await createLink(svc, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    if (!Either.isRight(created)) throw new Error("create failed");
    const res = await Effect.runPromise(Effect.either(svc.resolvePublic(created.right.token)));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ShareLinkNotFound);
  });

  it("unknown token → ShareLinkNotFound (same failure path)", async () => {
    seedShare(db);
    const svc = makeShareService(db);
    const res = await Effect.runPromise(Effect.either(svc.resolvePublic("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ShareLinkNotFound);
  });
});

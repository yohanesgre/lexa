import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
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
import { ProjectNotFound, WikiPageNotFound, SlugTaken, HasChildren, SearchError } from "../api/errors";
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
const DOC2: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "goodbye" }] }] };

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
}

function makeService(db: Database) {
  const layer = WikiService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WikiService);
}

describe("WikiService.create", () => {
  it("creates a page with slugified title, content, and contentText", async () => {
    seed(db);
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.create("p1", { title: "Getting Started", content: DOC, contentText: "hello" })));
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.slug).toBe("getting-started");
      expect(res.right.title).toBe("Getting Started");
      expect(res.right.parentId).toBeNull();
      expect(res.right.position).toBe(0);
      expect(res.right.content).toEqual(DOC);
      const raw = db.prepare("SELECT content_text FROM wiki_pages WHERE id = ?").get(res.right.id) as { content_text: string };
      expect(raw.content_text).toBe("hello");
    }
  });

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

  it("unknown project → ProjectNotFound", async () => {
    seed(db);
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.create("nope", { title: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });

  it("nested children get positions scoped to their parent", async () => {
    seed(db);
    const svc = makeService(db);
    const root1 = await Effect.runPromise(svc.create("p1", { title: "Root 1" }));
    const root2 = await Effect.runPromise(svc.create("p1", { title: "Root 2" }));
    expect(root1.position).toBe(0);
    expect(root2.position).toBe(1);
    const child1 = await Effect.runPromise(svc.create("p1", { title: "Child 1", parentId: root1.id }));
    const child2 = await Effect.runPromise(svc.create("p1", { title: "Child 2", parentId: root1.id }));
    expect(child1.parentId).toBe(root1.id);
    expect(child1.position).toBe(0);
    expect(child2.position).toBe(1);
    // a root sibling created after the children still counts root siblings only
    const root3 = await Effect.runPromise(svc.create("p1", { title: "Root 3" }));
    expect(root3.position).toBe(2);
  });
});

describe("WikiService.read", () => {
  it("findByProject returns metas ordered by parent then position", async () => {
    seed(db);
    const svc = makeService(db);
    const root = await Effect.runPromise(svc.create("p1", { title: "Root" }));
    await Effect.runPromise(svc.create("p1", { title: "Child", parentId: root.id }));
    const pages = await Effect.runPromise(svc.findByProject("p1"));
    // ORDER BY COALESCE(parent_id, '') ASC → roots (''), then children by parent
    expect(pages.map((p) => p.title)).toEqual(["Root", "Child"]);
  });

  it("findChildren returns only direct children ordered by position", async () => {
    seed(db);
    const svc = makeService(db);
    const root = await Effect.runPromise(svc.create("p1", { title: "Root" }));
    const c1 = await Effect.runPromise(svc.create("p1", { title: "B", parentId: root.id }));
    const c2 = await Effect.runPromise(svc.create("p1", { title: "A", parentId: root.id }));
    const children = await Effect.runPromise(svc.findChildren("p1", root.id));
    expect(children.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(children.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("findBySlug missing → WikiPageNotFound; unknown project → ProjectNotFound", async () => {
    seed(db);
    const svc = makeService(db);
    const missing = await Effect.runPromise(Effect.either(svc.findBySlug("p1", "nope")));
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(WikiPageNotFound);
    const noProject = await Effect.runPromise(Effect.either(svc.findBySlug("nope", "home")));
    expect(Either.isLeft(noProject)).toBe(true);
    if (Either.isLeft(noProject)) expect(noProject.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("WikiService.update", () => {
  it("updates title/content/contentText and records an autosave revision of the prior state", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "Old", content: DOC, contentText: "hello" }));
    const updated = await Effect.runPromise(
      Effect.either(svc.update(page.id, { title: "New", content: JSON.stringify(DOC2), contentText: "goodbye" }))
    );
    expect(Either.isRight(updated)).toBe(true);
    if (Either.isRight(updated)) {
      expect(updated.right.title).toBe("New");
      expect(updated.right.content).toEqual(DOC2);
    }
    const revisions = db.prepare("SELECT title, content_text, save_type FROM wiki_page_revisions WHERE page_id = ?").all(page.id) as { title: string; content_text: string; save_type: string }[];
    expect(revisions).toEqual([{ title: "Old", content_text: "hello", save_type: "autosave" }]);
  });

  it("slug conflict on update → ConstraintViolation (no SlugTaken at service layer)", async () => {
    seed(db);
    const svc = makeService(db);
    const a = await Effect.runPromise(svc.create("p1", { title: "A" }));
    await Effect.runPromise(svc.create("p1", { title: "B" }));
    const res = await Effect.runPromise(Effect.either(svc.update(a.id, { slug: "b" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left._tag).toBe("ConstraintViolation");
  });

  it("moves a page under a new parent and repositions it", async () => {
    seed(db);
    const svc = makeService(db);
    const a = await Effect.runPromise(svc.create("p1", { title: "A" }));
    const b = await Effect.runPromise(svc.create("p1", { title: "B" }));
    const moved = await Effect.runPromise(Effect.either(svc.update(b.id, { parentId: a.id, position: 5 })));
    expect(Either.isRight(moved)).toBe(true);
    if (Either.isRight(moved)) {
      expect(moved.right.parentId).toBe(a.id);
      expect(moved.right.position).toBe(5);
    }
    // back to root
    const reRooted = await Effect.runPromise(Effect.either(svc.update(b.id, { parentId: null })));
    expect(Either.isRight(reRooted)).toBe(true);
    if (Either.isRight(reRooted)) expect(reRooted.right.parentId).toBeNull();
  });

  it("missing id → WikiPageNotFound", async () => {
    seed(db);
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.update("nope", { title: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });

  it("prunes revisions to the newest 100", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "P" }));
    for (let i = 0; i < 105; i++) {
      await Effect.runPromise(svc.update(page.id, { contentText: `v${i}` }));
    }
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_page_revisions WHERE page_id = ?").get(page.id) as { n: number }).n;
    expect(n).toBe(100);
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

  it("restoreRevision rolls back title/slug/content and records a manual revision", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "Guide", content: DOC, contentText: "old text" }));
    await Effect.runPromise(svc.update(page.id, { title: "Guide 2", content: JSON.stringify(DOC2), contentText: "new text" }));
    const revisions = await Effect.runPromise(svc.listRevisions("guide", "p1"));
    expect(revisions).toHaveLength(1);
    const restored = await Effect.runPromise(Effect.either(svc.restoreRevision(revisions[0]!.id, "guide", "p1")));
    expect(Either.isRight(restored)).toBe(true);
    if (Either.isRight(restored)) {
      expect(restored.right.title).toBe("Guide");
      expect(restored.right.content).toEqual(DOC);
    }
    const after = db.prepare("SELECT title, save_type FROM wiki_page_revisions WHERE page_id = ?").all(page.id) as { title: string; save_type: string }[];
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.save_type).sort()).toEqual(["autosave", "manual"]);
  });

  it("restoring a revision of a different page → WikiPageNotFound", async () => {
    seed(db);
    const svc = makeService(db);
    const a = await Effect.runPromise(svc.create("p1", { title: "A" }));
    const b = await Effect.runPromise(svc.create("p1", { title: "B" }));
    await Effect.runPromise(svc.update(a.id, { title: "A2" }));
    const revs = await Effect.runPromise(svc.listRevisions("a", "p1"));
    const res = await Effect.runPromise(Effect.either(svc.restoreRevision(revs[0]!.id, "b", "p1")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
    const unchanged = await Effect.runPromise(svc.findBySlug("p1", "b"));
    expect(unchanged.title).toBe("B");
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

  it("missing id → WikiPageNotFound", async () => {
    seed(db);
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.delete("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
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

  it("scopes results per project and respects the limit", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(svc.create("p1", { title: "One", contentText: "fractional" }));
    await Effect.runPromise(svc.create("p1", { title: "Two", contentText: "fractional" }));
    await Effect.runPromise(svc.create("p2", { title: "Other", contentText: "fractional" }));
    const all = await Effect.runPromise(svc.search("p1", "fractional"));
    expect(all).toHaveLength(2);
    const limited = await Effect.runPromise(svc.search("p1", "fractional", 1));
    expect(limited).toHaveLength(1);
    const other = await Effect.runPromise(svc.search("p2", "fractional"));
    expect(other).toHaveLength(1);
    const none = await Effect.runPromise(svc.search("p1", "zzz"));
    expect(none).toEqual([]);
  });

  it("update re-indexes contentText via the FTS trigger", async () => {
    seed(db);
    const svc = makeService(db);
    const page = await Effect.runPromise(svc.create("p1", { title: "P", contentText: "alpha" }));
    let results = await Effect.runPromise(svc.search("p1", "alpha"));
    expect(results).toHaveLength(1);
    results = await Effect.runPromise(svc.search("p1", "beta"));
    expect(results).toHaveLength(0);
    await Effect.runPromise(svc.update(page.id, { contentText: "beta" }));
    results = await Effect.runPromise(svc.search("p1", "beta"));
    expect(results).toHaveLength(1);
  });

  it("invalid FTS5 query → SearchError", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(svc.create("p1", { title: "P", contentText: "alpha" }));
    const res = await Effect.runPromise(Effect.either(svc.search("p1", "\"unterminated")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(SearchError);
  });

  it("hyphenated query → SearchError (FTS5 parses '-' as column syntax)", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(svc.create("p1", { title: "P", contentText: "alpha" }));
    const res = await Effect.runPromise(Effect.either(svc.search("p1", "foo-bar")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(SearchError);
  });
});

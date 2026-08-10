import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { WikiService } from "./wiki.service";
import { ProjectNotFound, WikiPageNotFound, SlugTaken, HasChildren, SearchError } from "../api/errors";
import type { TipTapDoc } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

const DOC: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] };
const DOC2: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "goodbye" }] }] };

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-wiki-svc-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
}

function makeService(db: Database) {
  const layer = WikiService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WikiService);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("WikiService.create", () => {
  it("creates a page with slugified title, content, and contentText", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.create("p1", { title: "Getting Started", content: DOC, contentText: "hello" })));
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

  it("slug uniqueness is per project — same slug in another project is fine", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(Effect.either(svc.create("p1", { title: "Home" })));
    const dup = Effect.runSync(Effect.either(svc.create("p1", { title: "Home" })));
    expect(Either.isLeft(dup)).toBe(true);
    if (Either.isLeft(dup)) expect(dup.left).toBeInstanceOf(SlugTaken);
    const other = Effect.runSync(Effect.either(svc.create("p2", { title: "Home" })));
    expect(Either.isRight(other)).toBe(true);
    if (Either.isRight(other)) expect(other.right.slug).toBe("home");
  });

  it("unknown project → ProjectNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.create("nope", { title: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });

  it("nested children get positions scoped to their parent", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const root1 = Effect.runSync(svc.create("p1", { title: "Root 1" }));
    const root2 = Effect.runSync(svc.create("p1", { title: "Root 2" }));
    expect(root1.position).toBe(0);
    expect(root2.position).toBe(1);
    const child1 = Effect.runSync(svc.create("p1", { title: "Child 1", parentId: root1.id }));
    const child2 = Effect.runSync(svc.create("p1", { title: "Child 2", parentId: root1.id }));
    expect(child1.parentId).toBe(root1.id);
    expect(child1.position).toBe(0);
    expect(child2.position).toBe(1);
    // a root sibling created after the children still counts root siblings only
    const root3 = Effect.runSync(svc.create("p1", { title: "Root 3" }));
    expect(root3.position).toBe(2);
  });
});

describe("WikiService.read", () => {
  it("findByProject returns metas ordered by parent then position", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const root = Effect.runSync(svc.create("p1", { title: "Root" }));
    Effect.runSync(svc.create("p1", { title: "Child", parentId: root.id }));
    const pages = Effect.runSync(svc.findByProject("p1"));
    // ORDER BY COALESCE(parent_id, '') ASC → roots (''), then children by parent
    expect(pages.map((p) => p.title)).toEqual(["Root", "Child"]);
  });

  it("findChildren returns only direct children ordered by position", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const root = Effect.runSync(svc.create("p1", { title: "Root" }));
    const c1 = Effect.runSync(svc.create("p1", { title: "B", parentId: root.id }));
    const c2 = Effect.runSync(svc.create("p1", { title: "A", parentId: root.id }));
    const children = Effect.runSync(svc.findChildren("p1", root.id));
    expect(children.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(children.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("findBySlug missing → WikiPageNotFound; unknown project → ProjectNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const missing = Effect.runSync(Effect.either(svc.findBySlug("p1", "nope")));
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(WikiPageNotFound);
    const noProject = Effect.runSync(Effect.either(svc.findBySlug("nope", "home")));
    expect(Either.isLeft(noProject)).toBe(true);
    if (Either.isLeft(noProject)) expect(noProject.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("WikiService.update", () => {
  it("updates title/content/contentText and records an autosave revision of the prior state", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "Old", content: DOC, contentText: "hello" }));
    const updated = Effect.runSync(
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

  it("slug conflict on update → ConstraintViolation (no SlugTaken at service layer)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const a = Effect.runSync(svc.create("p1", { title: "A" }));
    Effect.runSync(svc.create("p1", { title: "B" }));
    const res = Effect.runSync(Effect.either(svc.update(a.id, { slug: "b" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left._tag).toBe("ConstraintViolation");
  });

  it("moves a page under a new parent and repositions it", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const a = Effect.runSync(svc.create("p1", { title: "A" }));
    const b = Effect.runSync(svc.create("p1", { title: "B" }));
    const moved = Effect.runSync(Effect.either(svc.update(b.id, { parentId: a.id, position: 5 })));
    expect(Either.isRight(moved)).toBe(true);
    if (Either.isRight(moved)) {
      expect(moved.right.parentId).toBe(a.id);
      expect(moved.right.position).toBe(5);
    }
    // back to root
    const reRooted = Effect.runSync(Effect.either(svc.update(b.id, { parentId: null })));
    expect(Either.isRight(reRooted)).toBe(true);
    if (Either.isRight(reRooted)) expect(reRooted.right.parentId).toBeNull();
  });

  it("missing id → WikiPageNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.update("nope", { title: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });

  it("prunes revisions to the newest 100", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "P" }));
    for (let i = 0; i < 105; i++) {
      Effect.runSync(svc.update(page.id, { contentText: `v${i}` }));
    }
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_page_revisions WHERE page_id = ?").get(page.id) as { n: number }).n;
    expect(n).toBe(100);
  });
});

describe("WikiService revisions", () => {
  it("listRevisions returns newest-first summaries with saveType; getRevision returns full revision", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "P", content: DOC, contentText: "hello" }));
    Effect.runSync(svc.update(page.id, { title: "P2" }, "manual"));
    const summaries = Effect.runSync(svc.listRevisions("p", "p1"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.saveType).toBe("manual");
    expect(summaries[0]!.title).toBe("P");
    const full = Effect.runSync(Effect.either(svc.getRevision(summaries[0]!.id)));
    expect(Either.isRight(full)).toBe(true);
    if (Either.isRight(full)) {
      expect(full.right.pageId).toBe(page.id);
      // revisions snapshot the plain-text projection derived from the content
      expect(full.right.contentText).toBe("hello");
      expect(full.right.content).toEqual(DOC);
    }
  });

  it("restoreRevision rolls back title/slug/content and records a manual revision", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "Guide", content: DOC, contentText: "old text" }));
    Effect.runSync(svc.update(page.id, { title: "Guide 2", content: JSON.stringify(DOC2), contentText: "new text" }));
    const revisions = Effect.runSync(svc.listRevisions("guide", "p1"));
    expect(revisions).toHaveLength(1);
    const restored = Effect.runSync(Effect.either(svc.restoreRevision(revisions[0]!.id, "guide", "p1")));
    expect(Either.isRight(restored)).toBe(true);
    if (Either.isRight(restored)) {
      expect(restored.right.title).toBe("Guide");
      expect(restored.right.content).toEqual(DOC);
    }
    const after = db.prepare("SELECT title, save_type FROM wiki_page_revisions WHERE page_id = ?").all(page.id) as { title: string; save_type: string }[];
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.save_type).sort()).toEqual(["autosave", "manual"]);
  });

  it("restoring a revision of a different page → WikiPageNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const a = Effect.runSync(svc.create("p1", { title: "A" }));
    const b = Effect.runSync(svc.create("p1", { title: "B" }));
    Effect.runSync(svc.update(a.id, { title: "A2" }));
    const revs = Effect.runSync(svc.listRevisions("a", "p1"));
    const res = Effect.runSync(Effect.either(svc.restoreRevision(revs[0]!.id, "b", "p1")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
    const unchanged = Effect.runSync(svc.findBySlug("p1", "b"));
    expect(unchanged.title).toBe("B");
  });
});

describe("WikiService.delete", () => {
  it("deletes a leaf page and its revisions", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "Leaf" }));
    Effect.runSync(svc.update(page.id, { title: "Leaf 2" }));
    const res = Effect.runSync(Effect.either(svc.delete(page.id)));
    expect(Either.isRight(res)).toBe(true);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE id = ?").get(page.id) as { n: number }).n;
    expect(n).toBe(0);
    const revs = (db.prepare("SELECT COUNT(*) AS n FROM wiki_page_revisions WHERE page_id = ?").get(page.id) as { n: number }).n;
    expect(revs).toBe(0);
  });

  it("page with children → HasChildren with the child count", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const parent = Effect.runSync(svc.create("p1", { title: "Parent" }));
    Effect.runSync(svc.create("p1", { title: "Child", parentId: parent.id }));
    const res = Effect.runSync(Effect.either(svc.delete(parent.id)));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(HasChildren);
      if (res.left instanceof HasChildren) expect(res.left.count).toBe(1);
    }
    const n = (db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE id = ?").get(parent.id) as { n: number }).n;
    expect(n).toBe(1);
  });

  it("missing id → WikiPageNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.delete("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(WikiPageNotFound);
  });
});

describe("WikiService.search", () => {
  it("FTS5 finds pages by contentText with a snippet", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "Indexing", content: DOC, contentText: "fractional indexing keeps keys short" }));
    const results = Effect.runSync(Effect.either(svc.search("p1", "fractional")));
    expect(Either.isRight(results)).toBe(true);
    if (Either.isRight(results)) {
      expect(results.right).toHaveLength(1);
      expect(results.right[0]!.id).toBe(page.id);
      expect(results.right[0]!.snippet).toContain("fractional");
    }
  });

  it("scopes results per project and respects the limit", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(svc.create("p1", { title: "One", contentText: "fractional" }));
    Effect.runSync(svc.create("p1", { title: "Two", contentText: "fractional" }));
    Effect.runSync(svc.create("p2", { title: "Other", contentText: "fractional" }));
    const all = Effect.runSync(svc.search("p1", "fractional"));
    expect(all).toHaveLength(2);
    const limited = Effect.runSync(svc.search("p1", "fractional", 1));
    expect(limited).toHaveLength(1);
    const other = Effect.runSync(svc.search("p2", "fractional"));
    expect(other).toHaveLength(1);
    const none = Effect.runSync(svc.search("p1", "zzz"));
    expect(none).toEqual([]);
  });

  it("update re-indexes contentText via the FTS trigger", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const page = Effect.runSync(svc.create("p1", { title: "P", contentText: "alpha" }));
    let results = Effect.runSync(svc.search("p1", "alpha"));
    expect(results).toHaveLength(1);
    results = Effect.runSync(svc.search("p1", "beta"));
    expect(results).toHaveLength(0);
    Effect.runSync(svc.update(page.id, { contentText: "beta" }));
    results = Effect.runSync(svc.search("p1", "beta"));
    expect(results).toHaveLength(1);
  });

  it("invalid FTS5 query → SearchError", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(svc.create("p1", { title: "P", contentText: "alpha" }));
    const res = Effect.runSync(Effect.either(svc.search("p1", "\"unterminated")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(SearchError);
  });

  it("hyphenated query → SearchError (FTS5 parses '-' as column syntax)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(svc.create("p1", { title: "P", contentText: "alpha" }));
    const res = Effect.runSync(Effect.either(svc.search("p1", "foo-bar")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(SearchError);
  });
});

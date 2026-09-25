import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { WikiRepo } from "./wiki.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const DOC = JSON.stringify({ type: "doc", content: [] });

let dir: string;
let db: Database;
let repo: WikiRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = WikiRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, WikiRepo);
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1','P1','p1'), ('p2','P2','p2')`);
}

describe("WikiRepo", () => {
  it("creates a page and reads it back by id and slug", async () => {
    setup();
    const created = await Effect.runPromise(repo.create({
      id: "w1", projectId: "p1", title: "Getting Started", slug: "getting-started",
      content: DOC, contentText: "hello world", position: 0,
    }));
    expect(created.title).toBe("Getting Started");
    expect(created.slug).toBe("getting-started");
    expect(created.parentId).toBeNull();

    const byId = await Effect.runPromise(repo.findById("w1"));
    expect(byId.id).toBe("w1");
    const bySlug = await Effect.runPromise(repo.findBySlug("p1", "getting-started"));
    expect(bySlug.id).toBe("w1");
  });

  it("retrieves a parent/child tree and orders the project listing", async () => {
    setup();
    const rootA = await Effect.runPromise(repo.create({ id: "a", projectId: "p1", title: "A", slug: "a", content: DOC, contentText: "", position: 0 }));
    const rootB = await Effect.runPromise(repo.create({ id: "b", projectId: "p1", title: "B", slug: "b", content: DOC, contentText: "", position: 1 }));
    const child1 = await Effect.runPromise(repo.create({ id: "a1", projectId: "p1", title: "A1", slug: "a1", content: DOC, contentText: "", parentId: rootA.id, position: 0 }));
    await Effect.runPromise(repo.create({ id: "a2", projectId: "p1", title: "A2", slug: "a2", content: DOC, contentText: "", parentId: rootA.id, position: 1 }));

    const children = await Effect.runPromise(repo.findChildren("p1", rootA.id));
    expect(children.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(children[0]!.parentId).toBe("a");

    const all = await Effect.runPromise(repo.findByProject("p1"));
    expect(all.map((p) => p.id)).toEqual(["a", "b", "a1", "a2"]);
    expect(rootB.id).toBe("b");
    expect(child1.parentId).toBe("a");
  });

  it("update moves a page under a new parent and changes fields; unknown id → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "a", projectId: "p1", title: "A", slug: "a", content: DOC, contentText: "", position: 0 }));
    await Effect.runPromise(repo.create({ id: "b", projectId: "p1", title: "B", slug: "b", content: DOC, contentText: "", position: 1 }));
    await Effect.runPromise(repo.create({ id: "c", projectId: "p1", title: "C", slug: "c", content: DOC, contentText: "", position: 2 }));

    const moved = await Effect.runPromise(repo.update("c", { title: "C moved", parentId: "a", position: 0 }));
    expect(moved.title).toBe("C moved");
    expect(moved.parentId).toBe("a");
    expect(moved.position).toBe(0);
    const children = await Effect.runPromise(repo.findChildren("p1", "a"));
    expect(children.map((c) => c.id)).toEqual(["c"]);

    const missing = await Effect.runPromise(Effect.either(repo.update("nope", { title: "x" })));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("enforces slug uniqueness per project (same slug across projects is allowed)", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "w1", projectId: "p1", title: "T", slug: "dup", content: DOC, contentText: "" }));
    const clash = await Effect.runPromise(Effect.either(repo.create({ id: "w2", projectId: "p1", title: "T2", slug: "dup", content: DOC, contentText: "" })));
    expect(clash).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const otherProject = await Effect.runPromise(repo.create({ id: "w3", projectId: "p2", title: "T3", slug: "dup", content: DOC, contentText: "" }));
    expect(otherProject.projectId).toBe("p2");
  });

  it("delete cascades revisions for a leaf; deleting a parent with children is restricted", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "parent", projectId: "p1", title: "P", slug: "p", content: DOC, contentText: "" }));
    await Effect.runPromise(repo.create({ id: "child", projectId: "p1", title: "C", slug: "c", content: DOC, contentText: "", parentId: "parent" }));
    await Effect.runPromise(repo.create({ id: "keep", projectId: "p1", title: "K", slug: "k", content: DOC, contentText: "" }));
    await Effect.runPromise(repo.create({ id: "keeper", projectId: "p1", title: "K1", slug: "k1", content: DOC, contentText: "", parentId: "keep" }));
    const rev = await Effect.runPromise(repo.createRevision("child", "C", "c", DOC, "", "manual"));

    await Effect.runPromise(repo.delete("child"));
    const revisions = await Effect.runPromise(repo.listRevisions("child"));
    expect(revisions).toHaveLength(0);
    expect(rev.id).toBeTruthy();
    expect(await Effect.runPromise(repo.countChildren("parent"))).toBe(0);

    const blocked = await Effect.runPromise(Effect.either(repo.delete("keep")));
    expect(blocked).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
    expect(await Effect.runPromise(repo.countChildren("keep"))).toBe(1);
  });

  it("maxPosition tracks sibling ordering and pruneRevisions keeps the newest N", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "a", projectId: "p1", title: "A", slug: "a", content: DOC, contentText: "", position: 0 }));
    await Effect.runPromise(repo.create({ id: "a1", projectId: "p1", title: "A1", slug: "a1", content: DOC, contentText: "", parentId: "a", position: 0 }));
    await Effect.runPromise(repo.create({ id: "a2", projectId: "p1", title: "A2", slug: "a2", content: DOC, contentText: "", parentId: "a", position: 1 }));

    expect(await Effect.runPromise(repo.maxPosition("p1", null))).toBe(0);
    expect(await Effect.runPromise(repo.maxPosition("p1", "a"))).toBe(1);

    const r1 = await Effect.runPromise(repo.createRevision("a", "A", "a", DOC, "", "autosave"));
    const r2 = await Effect.runPromise(repo.createRevision("a", "A", "a", DOC, "", "autosave"));
    const r3 = await Effect.runPromise(repo.createRevision("a", "A", "a", DOC, "", "manual"));
    // Same-second inserts share created_at — pin distinct values so newest-N
    // eviction is deterministic rather than id-tiebreak dependent.
    db.prepare("UPDATE wiki_page_revisions SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:01", r1.id);
    db.prepare("UPDATE wiki_page_revisions SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:02", r2.id);
    db.prepare("UPDATE wiki_page_revisions SET created_at = ? WHERE id = ?").run("2026-01-01 00:00:03", r3.id);

    expect((await Effect.runPromise(repo.listRevisions("a"))).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    await Effect.runPromise(repo.pruneRevisions("a", 2));
    const kept = await Effect.runPromise(repo.listRevisions("a"));
    expect(kept.map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(kept.map((r) => r.createdAt)).toEqual(["2026-01-01 00:00:03", "2026-01-01 00:00:02"]);
  });

  it("search finds pages in the project by content text", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "s1", projectId: "p1", title: "Notes", slug: "notes", content: DOC, contentText: "lexical search needle" }));
    await Effect.runPromise(repo.create({ id: "s2", projectId: "p2", title: "Other", slug: "other", content: DOC, contentText: "lexical search needle" }));

    const hits = await Effect.runPromise(repo.search("p1", "needle"));
    expect(hits.map((h) => h.id)).toEqual(["s1"]);
  });
});

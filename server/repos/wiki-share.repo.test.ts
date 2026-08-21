import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { WikiShareRepo, buildSubtreeTree, type SubtreeRow } from "./wiki-share.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const SEED = `
INSERT INTO users (id, email, name) VALUES ('u1', 'u1@lexa.local', 'User One');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO wiki_pages (id, project_id, title, slug, parent_id, position) VALUES
  ('w1', 'p1', 'Root',       'root',       NULL, 0),
  ('w2', 'p1', 'Child',      'child',      'w1', 0),
  ('w3', 'p1', 'Grandchild', 'grandchild', 'w2', 0),
  ('w4', 'p1', 'Other',      'other',      NULL, 1);
`;

let dirs: string[] = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-share-test-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SEED);
  const layer = WikiShareRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  const repo = Context.get(ctx, WikiShareRepo);
  return { repo, db, close: () => db.close() };
}

function insertLink(repo: ReturnType<typeof makeRepo>["repo"], overrides: Partial<Parameters<typeof repo.insert>[0]> = {}) {
  return Effect.runSync(
    repo.insert({
      id: "l1",
      pageId: "w1",
      token: "tok-1",
      createdBy: "u1",
      ...overrides,
    })
  );
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("WikiShareRepo", () => {
  it("insert + listByPage returns the links ordered by creation", () => {
    const { repo, close } = makeRepo();
    try {
      insertLink(repo);
      insertLink(repo, { id: "l2", token: "tok-2" });
      const rows = Effect.runSync(repo.listByPage("w1"));
      expect(rows.map((r) => r.id)).toEqual(["l1", "l2"]);
      expect(rows[0]).toMatchObject({
        id: "l1",
        page_id: "w1",
        token: "tok-1",
        expires_at: null,
        created_by: "u1",
      });
      expect(rows[0].created_at).toBeTruthy();
      expect(rows[0].updated_at).toBeTruthy();
    } finally { close(); }
  });

  it("listByPage returns [] for a page without links", () => {
    const { repo, close } = makeRepo();
    try {
      expect(Effect.runSync(repo.listByPage("w4"))).toEqual([]);
    } finally { close(); }
  });

  it("deleteById returns true once then false", () => {
    const { repo, close } = makeRepo();
    try {
      insertLink(repo);
      expect(Effect.runSync(repo.deleteById("l1"))).toBe(true);
      expect(Effect.runSync(repo.deleteById("l1"))).toBe(false);
    } finally { close(); }
  });

  it("findByToken finds an exact token and null for unknown", () => {
    const { repo, close } = makeRepo();
    try {
      insertLink(repo);
      const row = Effect.runSync(repo.findByToken("tok-1"));
      expect(row?.id).toBe("l1");
      expect(Effect.runSync(repo.findByToken("nope"))).toBeNull();
    } finally { close(); }
  });

  it("findSubtreeRows returns root + nested descendants via CTE", () => {
    const { repo, close } = makeRepo();
    try {
      const rows = Effect.runSync(repo.findSubtreeRows("w1"));
      expect(rows.map((r) => r.id).sort()).toEqual(["w1", "w2", "w3"]);
      expect(rows[0].id).toBe("w1");
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("w2")?.parent_id).toBe("w1");
      expect(byId.get("w3")?.parent_id).toBe("w2");
    } finally { close(); }
  });

  it("findSubtreeRows from a mid-tree node returns only that subtree", () => {
    const { repo, close } = makeRepo();
    try {
      const rows = Effect.runSync(repo.findSubtreeRows("w2"));
      expect(rows.map((r) => r.id).sort()).toEqual(["w2", "w3"]);
    } finally { close(); }
  });

  it("buildSubtreeTree assembles the parent map in TS", () => {
    const rows: SubtreeRow[] = [
      { id: "w1", parent_id: null, title: "Root", slug: "root", content: "{}", updated_at: "2026-01-01" },
      { id: "w2", parent_id: "w1", title: "Child", slug: "child", content: "{}", updated_at: "2026-01-01" },
      { id: "w3", parent_id: "w2", title: "Grandchild", slug: "grandchild", content: "{}", updated_at: "2026-01-01" },
    ];
    const tree = buildSubtreeTree(rows);
    expect(tree?.page.id).toBe("w1");
    expect(tree?.children[0]?.page.id).toBe("w2");
    expect(tree?.children[0]?.children[0]?.page.id).toBe("w3");
    expect(buildSubtreeTree([])).toBeNull();
  });

  it("deleting a wiki page cascades its share links", () => {
    const { repo, db, close } = makeRepo();
    try {
      insertLink(repo, { id: "l4", pageId: "w4", token: "tok-4" });
      db.exec(`DELETE FROM wiki_pages WHERE id = 'w4'`);
      expect(Effect.runSync(repo.findByToken("tok-4"))).toBeNull();
      expect(Effect.runSync(repo.listByPage("w4"))).toEqual([]);
    } finally { close(); }
  });
});

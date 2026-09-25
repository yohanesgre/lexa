import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AttachmentRepo } from "./attachment.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AttachmentRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-attachment-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(database: Database) {
  database.exec("PRAGMA foreign_keys = OFF");
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { database.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { database.exec("DELETE FROM sqlite_sequence"); } catch {}
  database.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')`);
  db.exec(`INSERT INTO users (id, email, name) VALUES ('u1','u1@lexa.test','U1')`);
  db.exec(`INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c1','p1','Todo',0,'open')`);
  db.exec(`INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Backlog',0,'backlog')`);
  db.exec(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1','p1','c1','s1','T1','a0'), ('t2','p1','c1','s1','T2','a1')`);
  db.exec(`INSERT INTO wiki_pages (id, project_id, title, slug) VALUES ('w1','p1','W1','w1')`);
  const layer = AttachmentRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AttachmentRepo);
});

const base = {
  projectId: "p1",
  taskId: null as string | null,
  wikiPageId: null as string | null,
  filename: "f.txt",
  mimeType: "text/plain",
  sizeBytes: 123,
  sha256: "sha-a",
  storageKey: "sk-a",
  uploadedBy: "u1" as string | null,
};

describe("AttachmentRepo", () => {
  it("inserts task-linked and wiki-linked rows and round-trips fields", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "a1", taskId: "t1" }));
    const found = await Effect.runPromise(repo.findById("a1"));
    expect(found).toMatchObject({
      id: "a1",
      project_id: "p1",
      task_id: "t1",
      wiki_page_id: null,
      filename: "f.txt",
      mime_type: "text/plain",
      size_bytes: 123,
      sha256: "sha-a",
      storage_key: "sk-a",
      uploaded_by: "u1",
    });

    await Effect.runPromise(repo.insert({ ...base, id: "a2", taskId: null, wikiPageId: "w1", sha256: "sha-b", storageKey: "sk-b" }));
    const wiki = await Effect.runPromise(repo.findByWikiPageId("w1"));
    expect(wiki.map((a) => a.id)).toEqual(["a2"]);

    const bySha = await Effect.runPromise(repo.findByProjectAndSha("p1", "sha-a"));
    expect(bySha?.id).toBe("a1");
    expect(await Effect.runPromise(repo.findByProjectAndSha("p1", "nope"))).toBeNull();
  });

  it("findByTaskId orders by created_at then id", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "a1", taskId: "t1", sha256: "s1" }));
    await Effect.runPromise(repo.insert({ ...base, id: "a2", taskId: "t1", sha256: "s2" }));
    await Effect.runPromise(repo.insert({ ...base, id: "a3", taskId: "t1", sha256: "s3" }));
    db.exec(`UPDATE attachments SET created_at = '2026-01-01 00:00:00' WHERE id IN ('a1','a2')`);
    db.exec(`UPDATE attachments SET created_at = '2025-12-31 00:00:00' WHERE id = 'a3'`);
    // a3 oldest; a1/a2 share timestamp → id ASC tiebreak.
    const rows = await Effect.runPromise(repo.findByTaskId("t1"));
    expect(rows.map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    expect(await Effect.runPromise(repo.countByStorageKey("sk-a"))).toBe(3);
  });

  it("deleteById returns true when a row is removed, false when absent", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "a1", taskId: "t1" }));
    expect(await Effect.runPromise(repo.deleteById("a1"))).toBe(true);
    expect(await Effect.runPromise(repo.deleteById("a1"))).toBe(false);
    expect(await Effect.runPromise(repo.findById("a1"))).toBeNull();
  });

  it("task delete cascades attachments; user delete nulls uploader", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "a1", taskId: "t1" }));
    expect(await Effect.runPromise(repo.countByStorageKey("sk-a"))).toBe(1);
    db.exec(`DELETE FROM tasks WHERE id = 't1'`);
    expect(await Effect.runPromise(repo.findByTaskId("t1"))).toEqual([]);

    await Effect.runPromise(repo.insert({ ...base, id: "a2", taskId: "t2", sha256: "sha-c", storageKey: "sk-c" }));
    db.exec(`DELETE FROM users WHERE id = 'u1'`);
    const row = await Effect.runPromise(repo.findById("a2"));
    expect(row?.uploaded_by).toBeNull();
  });

  it("enforces task/wiki XOR CHECK and UNIQUE(project_id, sha256)", async () => {
    const neither = await Effect.runPromise(Effect.either(repo.insert({ ...base, id: "bad", taskId: null, wikiPageId: null })));
    expect(neither).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const both = await Effect.runPromise(Effect.either(repo.insert({ ...base, id: "bad2", taskId: "t1", wikiPageId: "w1" })));
    expect(both).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    await Effect.runPromise(repo.insert({ ...base, id: "a1", taskId: "t1" }));
    const dup = await Effect.runPromise(Effect.either(repo.insert({ ...base, id: "a2", taskId: "t2" })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    // Same sha in a different project is allowed.
    const other = await Effect.runPromise(Effect.either(repo.insert({ ...base, id: "a3", projectId: "p2", taskId: "t2" })));
    expect(other._tag).toBe("Right");
  });
});

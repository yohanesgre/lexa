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
import { SourceRepo } from "./source.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: SourceRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-source-repo-"));
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
  const layer = SourceRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, SourceRepo);
});

const base = {
  projectId: "p1",
  documentType: "task" as const,
  documentId: "t1",
  kind: "external" as const,
  title: "Ref",
  ref: "https://example.test/x",
};

describe("SourceRepo", () => {
  it("creates a source and reads it back via findById/findByDocument", async () => {
    const created = await Effect.runPromise(repo.create({ ...base, id: "s1" }));
    expect(created).toMatchObject({
      id: "s1",
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      kind: "external",
      title: "Ref",
      ref: "https://example.test/x",
    });
    const found = await Effect.runPromise(repo.findById("s1"));
    expect(found.kind).toBe("external");
    expect(found.ref).toBe("https://example.test/x");
    expect(created.createdAt).toBe(found.createdAt);

    const list = await Effect.runPromise(repo.findByDocument("p1", "task", "t1"));
    expect(list.map((s) => s.id)).toEqual(["s1"]);
    expect(await Effect.runPromise(Effect.either(repo.findById("nope")))).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "RowNotFound" }),
    });
  });

  it("findByDocument scopes by project, document type and document id", async () => {
    await Effect.runPromise(repo.create({ ...base, id: "s1", documentId: "d1" }));
    await Effect.runPromise(repo.create({ ...base, id: "s2", projectId: "p2", documentId: "d1", ref: "https://other.test/y" }));
    await Effect.runPromise(repo.create({ ...base, id: "s3", documentType: "wiki", documentId: "d1", kind: "wiki", title: "Wiki", ref: "slug", }));

    const p1Task = await Effect.runPromise(repo.findByDocument("p1", "task", "d1"));
    expect(p1Task.map((s) => s.id)).toEqual(["s1"]);
    const p2Task = await Effect.runPromise(repo.findByDocument("p2", "task", "d1"));
    expect(p2Task.map((s) => s.id)).toEqual(["s2"]);
    const p1Wiki = await Effect.runPromise(repo.findByDocument("p1", "wiki", "d1"));
    expect(p1Wiki.map((s) => s.id)).toEqual(["s3"]);
  });

  it("orders by created_at and removes via delete", async () => {
    await Effect.runPromise(repo.create({ ...base, id: "s1", ref: "r1" }));
    await Effect.runPromise(repo.create({ ...base, id: "s2", ref: "r2" }));
    db.exec(`UPDATE document_sources SET created_at = '2026-02-01 00:00:00' WHERE id = 's1'`);
    db.exec(`UPDATE document_sources SET created_at = '2026-01-01 00:00:00' WHERE id = 's2'`);
    const list = await Effect.runPromise(repo.findByDocument("p1", "task", "t1"));
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);

    expect(await Effect.runPromise(repo.delete("s2"))).toBe(1);
    expect(await Effect.runPromise(repo.delete("s2"))).toBe(0);
    const after = await Effect.runPromise(repo.findByDocument("p1", "task", "t1"));
    expect(after.map((s) => s.id)).toEqual(["s1"]);
  });

  it("enforces UNIQUE(document_type, document_id, kind, ref) and CHECK domains", async () => {
    await Effect.runPromise(repo.create({ ...base, id: "s1" }));
    const dup = await Effect.runPromise(Effect.either(repo.create({ ...base, id: "s2" })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const badKind = await Effect.runPromise(Effect.either(repo.create({ ...base, id: "s3", ref: "r3", kind: "bogus" as "external" })));
    expect(badKind).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const badType = await Effect.runPromise(Effect.either(repo.create({ ...base, id: "s4", ref: "r4", documentType: "bogus" as "task" })));
    expect(badType).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
  });

  it("project delete cascades document sources", async () => {
    await Effect.runPromise(repo.create({ ...base, id: "s1" }));
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(await Effect.runPromise(repo.findByDocument("p1", "task", "t1"))).toEqual([]);
    expect(await Effect.runPromise(Effect.either(repo.findById("s1")))).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "RowNotFound" }),
    });
  });
});

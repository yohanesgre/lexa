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
import { ChatAttachmentRepo } from "./chat-attachment.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: ChatAttachmentRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-chat-attachment-repo-"));
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
  db.exec(`INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
    VALUES ('chat','c1','p1','u1','[]'), ('chat','c2','p1','u1','[]')`);
  const layer = ChatAttachmentRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, ChatAttachmentRepo);
});

const base = {
  projectId: "p1",
  documentType: "chat",
  documentId: "c1",
  filename: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 42,
  sha256: "sha-a",
  storageKey: "blobs/sha-a",
  uploadedBy: "u1" as string | null,
};

describe("ChatAttachmentRepo", () => {
  it("inserts and round-trips all fields; unknown id → null", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "ca1" }));
    const found = await Effect.runPromise(repo.findById("ca1"));
    expect(found).toMatchObject({
      id: "ca1",
      project_id: "p1",
      document_type: "chat",
      document_id: "c1",
      filename: "notes.md",
      mime_type: "text/markdown",
      size_bytes: 42,
      sha256: "sha-a",
      storage_key: "blobs/sha-a",
      uploaded_by: "u1",
    });
    expect(await Effect.runPromise(repo.findById("nope"))).toBeNull();
  });

  it("findByThread scopes to one thread and orders created_at then id", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "ca1", sha256: "s1", storageKey: "blobs/s1" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca2", sha256: "s2", storageKey: "blobs/s2" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca3", sha256: "s3", storageKey: "blobs/s3" }));
    await Effect.runPromise(repo.insert({ ...base, id: "other", documentId: "c2", sha256: "s4", storageKey: "blobs/s4" }));
    db.exec(`UPDATE chat_attachments SET created_at = '2026-01-01 00:00:00' WHERE id IN ('ca1','ca2')`);
    db.exec(`UPDATE chat_attachments SET created_at = '2025-12-31 00:00:00' WHERE id = 'ca3'`);
    const rows = await Effect.runPromise(repo.findByThread("chat", "c1"));
    expect(rows.map((r) => r.id)).toEqual(["ca3", "ca1", "ca2"]);
    expect(await Effect.runPromise(repo.findByThread("chat", "c2"))).toMatchObject([{ id: "other" }]);
  });

  it("countByStorageKey counts every row sharing a blob", async () => {
    expect(await Effect.runPromise(repo.countByStorageKey("blobs/sha-a"))).toBe(0);
    await Effect.runPromise(repo.insert({ ...base, id: "ca1" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca2" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca3", storageKey: "blobs/else", sha256: "else" }));
    expect(await Effect.runPromise(repo.countByStorageKey("blobs/sha-a"))).toBe(2);
    expect(await Effect.runPromise(repo.countByStorageKey("blobs/missing"))).toBe(0);
  });

  it("deleteById reports whether a row was removed; deleteByThread removes a whole thread", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "ca1" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca2" }));
    await Effect.runPromise(repo.insert({ ...base, id: "ca3", documentId: "c2" }));
    expect(await Effect.runPromise(repo.deleteById("ca1"))).toBe(true);
    expect(await Effect.runPromise(repo.deleteById("ca1"))).toBe(false);
    expect(await Effect.runPromise(repo.deleteByThread("chat", "c1"))).toBe(1);
    expect(await Effect.runPromise(repo.findByThread("chat", "c1"))).toEqual([]);
    expect(await Effect.runPromise(repo.findByThread("chat", "c2"))).toMatchObject([{ id: "ca3" }]);
  });

  it("thread delete cascades rows; user delete nulls uploader", async () => {
    await Effect.runPromise(repo.insert({ ...base, id: "ca1" }));
    db.exec(`DELETE FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'`);
    expect(await Effect.runPromise(repo.findById("ca1"))).toBeNull();

    await Effect.runPromise(repo.insert({ ...base, id: "ca2", documentId: "c2" }));
    db.exec(`DELETE FROM users WHERE id = 'u1'`);
    expect((await Effect.runPromise(repo.findById("ca2")))?.uploaded_by).toBeNull();
  });
});

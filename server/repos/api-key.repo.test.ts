import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { ApiKeyRepo } from "./api-key.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: ApiKeyRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-api-key-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = ApiKeyRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, ApiKeyRepo);
  db.exec(`INSERT INTO users (id, email, name) VALUES ('u1','u1@example.com','User One'), ('u2','u2@example.com','User Two')`);
}

function lastUsed(id: string): string | null {
  const row = db.query(`SELECT last_used_at FROM api_keys WHERE id = ?`).get(id) as { last_used_at: string | null } | null;
  return row?.last_used_at ?? null;
}

describe("ApiKeyRepo", () => {
  it("create stores only the hash and returns it; raw key is not a lookup hit", async () => {
    setup();
    const created = await Effect.runPromise(repo.create({ id: "k1", name: "CI", keyHash: "hash-abc", userId: "u1" }));
    expect(created.id).toBe("k1");
    expect(created.key_hash).toBe("hash-abc");
    expect(created.name).toBe("CI");
    expect(created.user_id).toBe("u1");
    expect(created.last_used_at).toBeNull();
    expect("key" in created).toBe(false);
    expect(Object.keys(created)).not.toContain("key");

    const found = await Effect.runPromise(repo.findByHash("hash-abc"));
    expect(found.id).toBe("k1");

    const raw = await Effect.runPromise(Effect.either(repo.findByHash("raw-secret-key")));
    expect(raw).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("rejects a duplicate key_hash", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "k1", name: "a", keyHash: "hash-abc", userId: null }));
    const dup = await Effect.runPromise(Effect.either(repo.create({ id: "k2", name: "b", keyHash: "hash-abc", userId: null })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
  });

  it("listAll orders by created_at DESC and joins the owner", async () => {
    setup();
    db.exec(`INSERT INTO api_keys (id, name, key_hash, user_id, created_at) VALUES
      ('k_old','old','h_old','u1','2026-01-01 00:00:00'),
      ('k_new','new','h_new',NULL,'2026-01-02 00:00:00')`);
    const all = await Effect.runPromise(repo.listAll());
    expect(all.map((k) => k.id)).toEqual(["k_new", "k_old"]);
    expect(all[1]!.owner_email).toBe("u1@example.com");
    expect(all[1]!.owner_name).toBe("User One");
    expect(all[0]!.owner_email).toBeNull();
    expect(all[0]!.owner_name).toBeNull();
  });

  it("listByUser filters to the owner", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "k1", name: "a", keyHash: "h1", userId: "u1" }));
    await Effect.runPromise(repo.create({ id: "k2", name: "b", keyHash: "h2", userId: "u2" }));
    await Effect.runPromise(repo.create({ id: "k3", name: "c", keyHash: "h3", userId: "u1" }));
    const mine = await Effect.runPromise(repo.listByUser("u1"));
    expect(mine.map((k) => k.id).sort()).toEqual(["k1", "k3"]);
  });

  it("deleteById removes and fails RowNotFound on an unknown id", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "k1", name: "a", keyHash: "h1", userId: "u1" }));
    await Effect.runPromise(repo.deleteById("k1"));
    const gone = await Effect.runPromise(Effect.either(repo.findByHash("h1")));
    expect(gone).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });

    const missing = await Effect.runPromise(Effect.either(repo.deleteById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("deleteOwn is owner-scoped and hides foreign/missing rows", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "k1", name: "a", keyHash: "h1", userId: "u1" }));

    const foreign = await Effect.runPromise(Effect.either(repo.deleteOwn("k1", "u2")));
    expect(foreign).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
    await Effect.runPromise(repo.findByHash("h1"));

    await Effect.runPromise(repo.deleteOwn("k1", "u1"));
    const gone = await Effect.runPromise(Effect.either(repo.findByHash("h1")));
    expect(gone).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });

    const unknown = await Effect.runPromise(Effect.either(repo.deleteOwn("nope", "u1")));
    expect(unknown).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("touchIfStale updates a null/stale last_used_at and no-ops a recent one", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "k1", name: "a", keyHash: "h1", userId: "u1" }));
    expect(lastUsed("k1")).toBeNull();

    await Effect.runPromise(repo.touchIfStale("k1"));
    const first = lastUsed("k1");
    expect(first).not.toBeNull();

    await Effect.runPromise(repo.touchIfStale("k1"));
    expect(lastUsed("k1")).toBe(first);

    db.exec(`UPDATE api_keys SET last_used_at = datetime('now','-2 hours') WHERE id = 'k1'`);
    const stale = lastUsed("k1")!;
    await Effect.runPromise(repo.touchIfStale("k1"));
    expect(lastUsed("k1")! > stale).toBe(true);
  });

  it("touchIfStale on an unknown id is an audited no-op", async () => {
    setup();
    // docs/LAYERS.md: touchIfStale uses a conditional stale-only UPDATE and
    // treats 0 rows as normal — an unknown id must resolve, not fail.
    await expect(Effect.runPromise(repo.touchIfStale("nope"))).resolves.toBeUndefined();
  });
});

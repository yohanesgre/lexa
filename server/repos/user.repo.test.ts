import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { UserRepo } from "./user.repo";
import { RowNotFound } from "../db/driver";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-user-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
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

function makeRepo(db: Database) {
  const layer = UserRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, UserRepo);
}

function seedUser(db: Database) {
  db.prepare(
    "INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('u1','a@b.c','Old','member','2000-01-01 00:00:00','2000-01-01 00:00:00')"
  ).run();
}

describe("UserRepo.updateName", () => {
  it("updates the name and bumps updated_at", async () => {
    seedUser(db);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.updateName("u1", "New")));
    expect(Either.isRight(result)).toBe(true);
    const row = db.query("SELECT name, updated_at FROM users WHERE id = 'u1'").get() as { name: string; updated_at: string };
    expect(row.name).toBe("New");
    expect(row.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("fails with RowNotFound for an unknown user", async () => {
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.updateName("missing", "New")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
  });
});

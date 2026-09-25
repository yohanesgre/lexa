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
import { UserProjectRoleRepo } from "./user-project-role.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: UserProjectRoleRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-user-project-role-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = UserProjectRoleRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, UserProjectRoleRepo);
  db.exec(`INSERT INTO users (id, email, name) VALUES ('u1','u1@example.com','User One'), ('u2','u2@example.com','User Two')`);
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1','P One','p1'), ('p2','P Two','p2')`);
}

function roleCount(userId: string, projectId: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM user_project_roles WHERE user_id = ? AND project_id = ?`).get(userId, projectId) as { n: number };
  return row.n;
}

describe("UserProjectRoleRepo", () => {
  it("setRole inserts then changes role as an upsert (single row)", async () => {
    setup();
    await Effect.runPromise(repo.setRole("u1", "p1", "member"));
    expect((await Effect.runPromise(repo.findByUserAndProject("u1", "p1")))!.role).toBe("member");
    expect(roleCount("u1", "p1")).toBe(1);

    await Effect.runPromise(repo.setRole("u1", "p1", "admin"));
    const row = await Effect.runPromise(repo.findByUserAndProject("u1", "p1"));
    expect(row!.role).toBe("admin");
    expect(roleCount("u1", "p1")).toBe(1);
  });

  it("findByUserAndProject returns null when no grant exists", async () => {
    setup();
    expect(await Effect.runPromise(repo.findByUserAndProject("u1", "p1"))).toBeNull();
  });

  it("findByUserId orders by role then project and scopes to the user", async () => {
    setup();
    await Effect.runPromise(repo.setRole("u1", "p1", "admin"));
    await Effect.runPromise(repo.setRole("u1", "p2", "member"));
    await Effect.runPromise(repo.setRole("u2", "p1", "member"));
    const rows = await Effect.runPromise(repo.findByUserId("u1"));
    expect(rows.map((r) => [r.role, r.project_id])).toEqual([["admin", "p1"], ["member", "p2"]]);
  });

  it("findByProjectId orders by role then user and scopes to the project", async () => {
    setup();
    await Effect.runPromise(repo.setRole("u1", "p1", "member"));
    await Effect.runPromise(repo.setRole("u2", "p1", "admin"));
    await Effect.runPromise(repo.setRole("u1", "p2", "admin"));
    const rows = await Effect.runPromise(repo.findByProjectId("p1"));
    expect(rows.map((r) => [r.role, r.user_id])).toEqual([["admin", "u2"], ["member", "u1"]]);
  });

  it("removeAccess deletes the grant and is idempotent", async () => {
    setup();
    await Effect.runPromise(repo.setRole("u1", "p1", "member"));
    await Effect.runPromise(repo.removeAccess("u1", "p1"));
    expect(await Effect.runPromise(repo.findByUserAndProject("u1", "p1"))).toBeNull();
    await Effect.runPromise(repo.removeAccess("u1", "p1"));
    expect(roleCount("u1", "p1")).toBe(0);
  });

  it("enforces foreign keys on both user and project", async () => {
    setup();
    const badUser = await Effect.runPromise(Effect.either(repo.setRole("ghost", "p1", "member")));
    expect(badUser).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const badProject = await Effect.runPromise(Effect.either(repo.setRole("u1", "ghost", "member")));
    expect(badProject).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    expect(roleCount("u1", "p1")).toBe(0);
  });
});

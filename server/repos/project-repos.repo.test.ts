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
import { ProjectReposRepo } from "./project-repos.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: ProjectReposRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-project-repos-repo-"));
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
  const layer = ProjectReposRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, ProjectReposRepo);
});

describe("ProjectReposRepo", () => {
  it("replace links repos; listByProject orders by repo and round-trips flags", async () => {
    await Effect.runPromise(repo.replace("p1", [
      { repo: "owner/z", sourceRole: true, workspaceRole: false },
      { repo: "owner/a", sourceRole: false, workspaceRole: true },
    ]));
    const list = await Effect.runPromise(repo.listByProject("p1"));
    expect(list).toEqual([
      { repo: "owner/a", sourceRole: false, workspaceRole: true },
      { repo: "owner/z", sourceRole: true, workspaceRole: false },
    ]);
    expect(await Effect.runPromise(repo.listByProject("p2"))).toEqual([]);
  });

  it("replace is a full replace and can clear the list", async () => {
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/a", sourceRole: true, workspaceRole: true }]));
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/b", sourceRole: true, workspaceRole: false }]));
    expect((await Effect.runPromise(repo.listByProject("p1"))).map((r) => r.repo)).toEqual(["owner/b"]);
    await Effect.runPromise(repo.replace("p1", []));
    expect(await Effect.runPromise(repo.listByProject("p1"))).toEqual([]);
  });

  it("enforces UNIQUE(project_id, repo) atomically within replace", async () => {
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/keep", sourceRole: true, workspaceRole: true }]));
    const dup = await Effect.runPromise(Effect.either(repo.replace("p1", [
      { repo: "owner/x", sourceRole: true, workspaceRole: true },
      { repo: "owner/x", sourceRole: false, workspaceRole: true },
    ])));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
    // Failed replace rolls back; prior list survives.
    expect((await Effect.runPromise(repo.listByProject("p1"))).map((r) => r.repo)).toEqual(["owner/keep"]);
  });

  it("same repo can link to different projects; listByRepo spans projects", async () => {
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/shared", sourceRole: true, workspaceRole: true }]));
    await Effect.runPromise(repo.replace("p2", [{ repo: "owner/shared", sourceRole: false, workspaceRole: true }]));
    const rows = await Effect.runPromise(repo.listByRepo("owner/shared"));
    expect(rows.map((r) => r.project_id).sort()).toEqual(["p1", "p2"]);
  });

  it("project delete cascades project_repos", async () => {
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/a", sourceRole: true, workspaceRole: true }]));
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(await Effect.runPromise(repo.listByProject("p1"))).toEqual([]);
  });
});

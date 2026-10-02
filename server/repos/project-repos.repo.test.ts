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

  it("listByProjects batches by project id, preserving per-project repo order", async () => {
    await Effect.runPromise(repo.replace("p1", [
      { repo: "owner/z", sourceRole: true, workspaceRole: false },
      { repo: "owner/a", sourceRole: false, workspaceRole: true },
    ]));
    await Effect.runPromise(repo.replace("p2", [{ repo: "owner/b", sourceRole: true, workspaceRole: true }]));
    const grouped = await Effect.runPromise(repo.listByProjects(["p1", "p2", "missing"]));
    expect([...grouped.keys()].sort()).toEqual(["p1", "p2"]);
    expect(grouped.get("p1")).toEqual([
      { repo: "owner/a", sourceRole: false, workspaceRole: true },
      { repo: "owner/z", sourceRole: true, workspaceRole: false },
    ]);
    expect(grouped.get("p2")).toEqual([{ repo: "owner/b", sourceRole: true, workspaceRole: true }]);
    expect(grouped.get("missing")).toBeUndefined();
  });

  it("listByProjects returns an empty map for empty input", async () => {
    expect([...(await Effect.runPromise(repo.listByProjects([]))).keys()]).toEqual([]);
  });

  it("listByProjects chunks past the D1 100-param cap", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `pc-${String(i).padStart(3, "0")}`);
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ${ids.map((id) => `('${id}','${id}','${id}')`).join(",")}`);
    db.exec(`INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES ${ids.map((id, i) => `('r-${i}','${id}','o/r${i}',1,0)`).join(",")}`);
    const grouped = await Effect.runPromise(repo.listByProjects(ids));
    expect(grouped.size).toBe(120);
    expect(grouped.get(ids[0]!)).toEqual([{ repo: "o/r0", sourceRole: true, workspaceRole: false }]);
    expect(grouped.get(ids[89]!)).toEqual([{ repo: "o/r89", sourceRole: true, workspaceRole: false }]);
    expect(grouped.get(ids[90]!)).toEqual([{ repo: "o/r90", sourceRole: true, workspaceRole: false }]);
    expect(grouped.get(ids[119]!)).toEqual([{ repo: "o/r119", sourceRole: true, workspaceRole: false }]);
  });

  it("project delete cascades project_repos", async () => {
    await Effect.runPromise(repo.replace("p1", [{ repo: "owner/a", sourceRole: true, workspaceRole: true }]));
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(await Effect.runPromise(repo.listByProject("p1"))).toEqual([]);
  });
});

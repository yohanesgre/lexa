import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { ColumnRepo } from "./column.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-column-repo-"));
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
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
});

function makeRepo(db: Database) {
  const layer = ColumnRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ColumnRepo);
}

describe("ColumnRepo", () => {
  it("create round-trips defaults and findByProject orders by position", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "c-b", projectId: "p1", name: "B", position: 2 }));
    await Effect.runPromise(repo.create({ id: "c-a", projectId: "p1", name: "A", position: 0, color: "#111111", wipLimit: 3, requiredFields: ["priority"], githubState: "open" }));
    await Effect.runPromise(repo.create({ id: "c-c", projectId: "p1", name: "C", position: 1 }));

    const listed = await Effect.runPromise(repo.findByProject("p1"));
    expect(listed.map((c) => c.id)).toEqual(["c-a", "c-c", "c-b"]);
    expect(listed[0]).toMatchObject({ name: "A", color: "#111111", wipLimit: 3, requiredFields: ["priority"], githubState: "open", isDone: false });
    expect(listed[2]).toMatchObject({ name: "B", color: "#6b7280", wipLimit: null, requiredFields: [], githubState: null, isDone: false });
  });

  it("findById returns the row and RowNotFound for an unknown id", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "c1", projectId: "p1", name: "Todo", position: 0 }));
    const found = await Effect.runPromise(repo.findById("c1"));
    expect(found.name).toBe("Todo");

    const missing = await Effect.runPromise(Effect.either(repo.findById("nope")));
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) expect(missing.left._tag).toBe("RowNotFound");
  });

  it("update mutates the provided fields and returns the fresh row", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "c1", projectId: "p1", name: "Todo", position: 0 }));
    const updated = await Effect.runPromise(repo.update("c1", {
      name: "Doing",
      position: 5,
      color: "#abcdef",
      wipLimit: 4,
      requiredFields: ["priority", "type"],
      githubState: "closed",
      isDone: true,
    }));
    expect(updated).toMatchObject({ name: "Doing", position: 5, color: "#abcdef", wipLimit: 4, requiredFields: ["priority", "type"], githubState: "closed", isDone: true });

    const listed = await Effect.runPromise(repo.findByProject("p1"));
    expect(listed[0]!.isDone).toBe(true);
  });

  it("github_state round-trips open/closed/null; CHECK rejects other values", async () => {
    const repo = makeRepo(db);
    const open = await Effect.runPromise(repo.create({ id: "c1", projectId: "p1", name: "Todo", position: 0, githubState: "open" }));
    expect(open.githubState).toBe("open");

    const closed = await Effect.runPromise(repo.update("c1", { githubState: "closed" }));
    expect(closed.githubState).toBe("closed");

    const cleared = await Effect.runPromise(repo.update("c1", { githubState: null }));
    expect(cleared.githubState).toBeNull();
    const raw = db.query("SELECT github_state FROM columns WHERE id = 'c1'").get() as { github_state: string | null };
    expect(raw.github_state).toBeNull();

    expect(() => db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('bad','p1','X',0,'merged')").run()).toThrow(/CHECK/i);
  });

  it("enforces the project FK and tracks maxPosition/countTasks", async () => {
    const repo = makeRepo(db);
    const fk = await Effect.runPromise(Effect.either(repo.create({ id: "c-x", projectId: "ghost", name: "X", position: 0 })));
    expect(Either.isLeft(fk)).toBe(true);
    if (Either.isLeft(fk)) expect(fk.left._tag).toBe("ConstraintViolation");
    expect(await Effect.runPromise(repo.findByProject("ghost"))).toHaveLength(0);

    expect(await Effect.runPromise(repo.maxPosition("p1"))).toBe(-1);
    await Effect.runPromise(repo.create({ id: "c1", projectId: "p1", name: "Todo", position: 0 }));
    await Effect.runPromise(repo.create({ id: "c2", projectId: "p1", name: "Done", position: 7 }));
    expect(await Effect.runPromise(repo.maxPosition("p1"))).toBe(7);

    expect(await Effect.runPromise(repo.countTasks("c2"))).toBe(0);
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Backlog',0,'backlog')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1','p1','c2','s1','T','a0')").run();
    expect(await Effect.runPromise(repo.countTasks("c2"))).toBe(1);
    expect(await Effect.runPromise(repo.countTasks("c1"))).toBe(0);
  });
});

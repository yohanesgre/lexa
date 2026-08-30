import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { HearthRepo } from "./hearth.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-hearth-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
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


function seed(db: Database) {
  db.exec(`
    INSERT INTO runtimes (id, name, provider, status) VALUES ('rt1', 'rt1', 'opencode', 'online');
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
    INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
  `);
}

function makeRepo(db: Database) {
  const layer = HearthRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, HearthRepo);
}

function taskInput(id: string, kind?: "blacksmith" | "herald") {
  return {
    id,
    projectId: "p1",
    documentType: "task" as const,
    documentId: "t1",
    agentId: "a1",
    skillId: "sk1",
    extraPrompt: "",
    selection: "",
    docContext: "",
    ...(kind ? { kind } : {}),
  };
}

describe("HearthRepo createTask kind", () => {
  it("defaults to blacksmith", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const task = yield* repo.createTask(taskInput("ft1"));
        expect(task.kind).toBe("blacksmith");
      })
    );
  });

  it("kind='herald' is persisted", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const task = yield* repo.createTask(taskInput("ft2", "herald"));
        expect(task.kind).toBe("herald");
        expect(task.status).toBe("queued");
      })
    );
  });
});

describe("HearthRepo claimNextTask kind scoping", () => {
  it("never returns a herald task", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("ft-h", "herald"));
        yield* repo.createTask(taskInput("ft-b", "blacksmith"));
        const claimed = yield* repo.claimNextTask("rt1", null);
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe("ft-b");
        expect(claimed!.kind).toBe("blacksmith");
      })
    );
  });

  it("returns null when only herald tasks are queued", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("ft-h", "herald"));
        const claimed = yield* repo.claimNextTask("rt1", null);
        expect(claimed).toBeNull();
      })
    );
  });
});

describe("HearthRepo claimHeraldTask", () => {
  it("claims a queued herald task → running", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("ft-h", "herald"));
        const claimed = yield* repo.claimHeraldTask("ft-h");
        expect(claimed.status).toBe("running");
        expect(claimed.startedAt).not.toBeNull();
      })
    );
  });

  it("refuses a blacksmith task", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("ft-b", "blacksmith"));
        const err = yield* repo.claimHeraldTask("ft-b").pipe(Effect.flip);
        expect(err._tag).toBe("ConstraintViolation");
      })
    );
  });

  it("double claim fails on the second call", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("ft-h", "herald"));
        yield* repo.claimHeraldTask("ft-h");
        const err = yield* repo.claimHeraldTask("ft-h").pipe(Effect.flip);
        expect(err._tag).toBe("ConstraintViolation");
      })
    );
  });

  it("missing task fails", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.claimHeraldTask("ghost").pipe(Effect.flip);
        expect(err._tag).toBe("ConstraintViolation");
      })
    );
  });
});

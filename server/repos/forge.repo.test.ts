import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ForgeRepo } from "./forge.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-forge-repo-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function seed(db: Database) {
  db.exec(`
    INSERT INTO runtimes (id, name, provider, status) VALUES ('rt1', 'rt1', 'opencode', 'online');
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
    INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
  `);
}

function makeRepo(db: Database) {
  const layer = ForgeRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ForgeRepo);
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

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ForgeRepo createTask kind", () => {
  it("defaults to blacksmith", () => {
    const db = tmpDb();
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
    const db = tmpDb();
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

describe("ForgeRepo claimNextTask kind scoping", () => {
  it("never returns a herald task", () => {
    const db = tmpDb();
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
    const db = tmpDb();
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

describe("ForgeRepo claimHeraldTask", () => {
  it("claims a queued herald task → running", () => {
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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

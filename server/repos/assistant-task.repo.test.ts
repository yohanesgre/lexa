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
import { AssistantTaskRepo } from "./assistant-task.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-task-repo-"));
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
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
    INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
  `);
}

function makeRepo(db: Database) {
  const layer = AssistantTaskRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantTaskRepo);
}

function taskInput(id: string) {
  return {
    id,
    projectId: "p1",
    documentType: "task" as const,
    documentId: "t1",
    agentId: "a1",
    skillId: "sk1",
    extraPrompt: "",
    selection: "",
  };
}

describe("AssistantTaskRepo createTask", () => {
  it("inserts a queued task bound to agent/skill", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const task = yield* repo.createTask(taskInput("at1"));
        expect(task.status).toBe("queued");
        expect(task.agentId).toBe("a1");
        expect(task.skillId).toBe("sk1");
        expect(task.finishedAt).toBeNull();
      })
    );
  });
});

describe("AssistantTaskRepo claimAssistantTask", () => {
  it("claims a queued task → running", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        const claimed = yield* repo.claimAssistantTask("at1");
        expect(claimed.status).toBe("running");
        expect(claimed.startedAt).not.toBeNull();
      })
    );
  });

  it("double claim fails on the second call", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        yield* repo.claimAssistantTask("at1");
        const err = yield* repo.claimAssistantTask("at1").pipe(Effect.flip);
        expect(err._tag).toBe("ConstraintViolation");
      })
    );
  });

  it("missing task fails", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.claimAssistantTask("ghost").pipe(Effect.flip);
        expect(err._tag).toBe("ConstraintViolation");
      })
    );
  });
});

describe("AssistantTaskRepo updateTaskStatus transitions", () => {
  it("completes from running and records result", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        yield* repo.claimAssistantTask("at1");
        const done = yield* repo.updateTaskStatus("at1", "completed", "the result", null);
        expect(done.status).toBe("completed");
        expect(done.result).toBe("the result");
        expect(done.finishedAt).not.toBeNull();
      })
    );
  });

  it("fails from running with an error", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        yield* repo.claimAssistantTask("at1");
        const failed = yield* repo.updateTaskStatus("at1", "failed", null, "boom");
        expect(failed.status).toBe("failed");
        expect(failed.error).toBe("boom");
      })
    );
  });

  it("cancel transitions from queued", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        const cancelled = yield* repo.updateTaskStatus("at1", "cancelled", null, null);
        expect(cancelled.status).toBe("cancelled");
      })
    );
  });

  it("complete does NOT transition a queued task (stays queued)", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createTask(taskInput("at1"));
        const after = yield* repo.updateTaskStatus("at1", "completed", "x", null);
        expect(after.status).toBe("queued");
        expect(after.result).toBeNull();
      })
    );
  });
});

describe("AssistantTaskRepo counts + document listing", () => {
  it("counts by status, agent and skill", async () => {
    seed(db);
    db.exec(`
      INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status) VALUES
        ('at1','p1','task','t1','a1','sk1','queued'),
        ('at2','p1','task','t1','a1','sk1','running'),
        ('at3','p1','wiki','w1','a1','sk1','completed');
    `);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const counts = yield* repo.countByStatus();
        expect(counts).toEqual({ queued: 1, running: 1, completed: 1, failed: 0, cancelled: 0 });
        expect(yield* repo.countTasksByAgent("a1")).toBe(3);
        expect(yield* repo.countTasksBySkill("sk1")).toBe(3);
      })
    );
  });

  it("lists tasks for a document newest-first", async () => {
    seed(db);
    db.exec(`
      INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, created_at) VALUES
        ('at-old','p1','task','t1','a1','sk1','completed','2026-01-01 10:00:00'),
        ('at-new','p1','task','t1','a1','sk1','queued','2026-01-02 10:00:00');
    `);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const tasks = yield* repo.listTasksForDocument("p1", "task", "t1");
        expect(tasks.map((t) => t.id)).toEqual(["at-new", "at-old"]);
      })
    );
  });
});

describe("AssistantTaskRepo listRecent", () => {
  function seedRuns(db: Database) {
    seed(db);
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p2', 'P2', 'p2')`);
    db.exec(`
      INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, error, created_at) VALUES
        ('r1','p1','task','t1','a1','sk1','completed',NULL,'2026-01-01 10:00:00'),
        ('r2','p1','wiki','w1','a1','sk1','failed','boom','2026-01-02 10:00:00'),
        ('r3','p2','task','t2','a1','sk1','queued',NULL,'2026-01-03 10:00:00');
    `);
  }

  it("returns newest-first with names and no cursor when under the limit", async () => {
    seedRuns(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const page = yield* repo.listRecent({ limit: 10 });
        expect(page.tasks.map((t) => t.id)).toEqual(["r3", "r2", "r1"]);
        expect(page.tasks[0]!.agentName).toBe("A");
        expect(page.tasks[0]!.skillName).toBe("S");
        expect(page.tasks[1]!.error).toBe("boom");
        expect(page.nextCursor).toBeNull();
      })
    );
  });

  it("filters by status and projectId", async () => {
    seedRuns(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* repo.listRecent({ status: "failed", limit: 10 });
        expect(failed.tasks.map((t) => t.id)).toEqual(["r2"]);
        const p1 = yield* repo.listRecent({ projectId: "p1", limit: 10 });
        expect(p1.tasks.map((t) => t.id)).toEqual(["r2", "r1"]);
      })
    );
  });

  it("paginates via keyset cursor without overlap", async () => {
    seedRuns(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* repo.listRecent({ limit: 2 });
        expect(first.tasks.map((t) => t.id)).toEqual(["r3", "r2"]);
        expect(first.nextCursor).not.toBeNull();
        const second = yield* repo.listRecent({ limit: 2, cursor: first.nextCursor });
        expect(second.tasks.map((t) => t.id)).toEqual(["r1"]);
        expect(second.nextCursor).toBeNull();
      })
    );
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ForgeSessionRepo } from "./forge-session.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-forge-session-repo-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

// forge_tasks rows (for hasActiveTask) need their FK targets; forge_sessions
// itself is FK-free.
function seed(db: Database) {
  db.exec(`
    INSERT INTO runtimes (id, name, provider, status) VALUES ('rt1', 'rt1', 'opencode', 'online'), ('rt2', 'rt2', 'opencode', 'online');
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
    INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Main', 0, 'backlog');
    INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
    INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
  `);
}

function makeRepo(db: Database) {
  const layer = ForgeSessionRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ForgeSessionRepo);
}

function seedTask(db: Database, id: string, documentId: string, status: string, runtimeId: string | null) {
  db.prepare(
    `INSERT INTO forge_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id, created_at)
     VALUES (?, 'p1', 'task', ?, 'a1', 'sk1', ?, ?, datetime('now'))`
  ).run(id, documentId, status, runtimeId);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ForgeSessionRepo upsert/get", () => {
  it("upsert then get round-trips all fields", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({
          documentType: "task",
          documentId: "t1",
          runtimeId: "rt1",
          runtimeSessionId: "sess-1",
          provider: "opencode",
          agentId: "a1",
          skillId: "sk1",
        });
        const row = yield* repo.get("task", "t1", "rt1");
        expect(row).not.toBeNull();
        expect(row!.runtime_session_id).toBe("sess-1");
        expect(row!.provider).toBe("opencode");
        expect(row!.agent_id).toBe("a1");
        expect(row!.skill_id).toBe("sk1");
        expect(row!.document_type).toBe("task");
      })
    );
  });

  it("get returns null for a missing mapping", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        expect(yield* repo.get("wiki", "w1", "rt1")).toBeNull();
      })
    );
  });

  it("upsert twice updates agent/skill/session in place (no duplicate rows)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({ documentType: "task", documentId: "t1", runtimeId: "rt1", runtimeSessionId: "sess-1", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.upsert({ documentType: "task", documentId: "t1", runtimeId: "rt1", runtimeSessionId: "sess-2", provider: "opencode", agentId: "a1", skillId: "sk2" });
        const rows = yield* repo.listForDocument("task", "t1");
        expect(rows).toHaveLength(1);
        expect(rows[0].runtime_session_id).toBe("sess-2");
        expect(rows[0].skill_id).toBe("sk2");
      })
    );
  });
});

describe("ForgeSessionRepo per-runtime isolation", () => {
  it("same document on two runtimes → two rows; listForDocument returns both", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({ documentType: "wiki", documentId: "w1", runtimeId: "rt1", runtimeSessionId: "s1", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.upsert({ documentType: "wiki", documentId: "w1", runtimeId: "rt2", runtimeSessionId: "s2", provider: "opencode", agentId: "a1", skillId: "sk1" });
        const rows = yield* repo.listForDocument("wiki", "w1");
        expect(rows.map((r) => r.runtime_id).sort()).toEqual(["rt1", "rt2"]);
        expect(rows.every((r) => r.document_id === "w1")).toBe(true);
        expect(yield* repo.get("wiki", "w1", "rt1")).not.toBeNull();
        expect(yield* repo.get("wiki", "w1", "rt2")).not.toBeNull();
      })
    );
  });

  it("listForDocument is scoped to the document (other documents excluded)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({ documentType: "task", documentId: "t1", runtimeId: "rt1", runtimeSessionId: "s1", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.upsert({ documentType: "task", documentId: "t2", runtimeId: "rt1", runtimeSessionId: "s2", provider: "opencode", agentId: "a1", skillId: "sk1" });
        const rows = yield* repo.listForDocument("task", "t1");
        expect(rows).toHaveLength(1);
        expect(rows[0].document_id).toBe("t1");
      })
    );
  });
});

describe("ForgeSessionRepo remove", () => {
  it("remove deletes the mapping row", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({ documentType: "task", documentId: "t1", runtimeId: "rt1", runtimeSessionId: "s1", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.remove("task", "t1", "rt1");
        expect(yield* repo.get("task", "t1", "rt1")).toBeNull();
        // Removing a missing mapping is a no-op, not an error.
        yield* repo.remove("task", "nope", "rt1");
      })
    );
  });

  it("remove on one runtime leaves the other runtime's mapping intact", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert({ documentType: "wiki", documentId: "w1", runtimeId: "rt1", runtimeSessionId: "s1", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.upsert({ documentType: "wiki", documentId: "w1", runtimeId: "rt2", runtimeSessionId: "s2", provider: "opencode", agentId: "a1", skillId: "sk1" });
        yield* repo.remove("wiki", "w1", "rt1");
        const rows = yield* repo.listForDocument("wiki", "w1");
        expect(rows).toHaveLength(1);
        expect(rows[0].runtime_id).toBe("rt2");
      })
    );
  });
});

describe("ForgeSessionRepo hasActiveTask", () => {
  it("true when a queued or running task exists for the document+runtime", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        seedTask(db, "ft1", "t1", "queued", null);
        seedTask(db, "ft2", "t1", "running", "rt1");
        expect(yield* repo.hasActiveTask("task", "t1", "rt1")).toBe(true);
      })
    );
  });

  it("false for completed/failed/cancelled tasks", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        seedTask(db, "ft1", "t1", "completed", "rt1");
        seedTask(db, "ft2", "t1", "failed", "rt1");
        seedTask(db, "ft3", "t1", "cancelled", "rt1");
        expect(yield* repo.hasActiveTask("task", "t1", "rt1")).toBe(false);
      })
    );
  });

  it("false when no task row exists for the document", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        expect(yield* repo.hasActiveTask("task", "ghost", "rt1")).toBe(false);
      })
    );
  });

  it("false when the active task belongs to a different runtime", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        seedTask(db, "ft1", "t1", "running", "rt2");
        expect(yield* repo.hasActiveTask("task", "t1", "rt1")).toBe(false);
      })
    );
  });
});

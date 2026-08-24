import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { HeraldPendingWritesRepo, type HeraldPendingWriteRow } from "./herald-pending-writes.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-herald-pending-writes-repo-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

// herald_pending_writes FK targets: projects, users, and the composite
// herald_threads(document_type, document_id) key.
function seed(db: Database) {
  db.exec(`
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'member');
    INSERT INTO herald_threads (document_type, document_id, project_id)
      VALUES ('chat', 'c1', 'p1'), ('task', 't1', 'p1');
  `);
}

// Repo.insert always writes status='pending'; tests that need a pre-decided
// row flip it with a direct UPDATE.
function seedDecided(db: Database, id: string, status: string) {
  db.prepare(`UPDATE herald_pending_writes SET status = ? WHERE id = ?`).run(status, id);
}

function makeRepo(db: Database) {
  const layer = HeraldPendingWritesRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, HeraldPendingWritesRepo);
}

function row(overrides: Partial<HeraldPendingWriteRow>): HeraldPendingWriteRow {
  return {
    id: crypto.randomUUID(),
    project_id: "p1",
    document_type: "chat",
    document_id: "c1",
    owner_user_id: "u1",
    batch_id: "b1",
    seq: 0,
    tool_name: "create_task",
    args: "{}",
    diff: "{}",
    status: "pending",
    execution_error: null,
    created_at: "",
    expires_at: "9999-01-01 00:00:00",
    decided_at: null,
    ...overrides,
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

describe("HeraldPendingWritesRepo insert/getById", () => {
  it("insert defaults status='pending' and round-trips via getById", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const r = row({ id: "w1" });
        yield* repo.insert(r);
        const got = yield* repo.getById("w1");
        expect(got).not.toBeNull();
        expect(got!.status).toBe("pending");
        expect(got!.batch_id).toBe("b1");
        expect(got!.seq).toBe(0);
        expect(got!.execution_error).toBeNull();
        expect(got!.decided_at).toBeNull();
        expect(yield* repo.getById("missing")).toBeNull();
      })
    );
  });

  it("FK enforcement: insert without the herald_threads composite key fails", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(repo.insert(row({ document_id: "ghost" })));
        expect(exit._tag).toBe("Failure");
      })
    );
  });
});

describe("HeraldPendingWritesRepo decide guard paths", () => {
  it("pending → approved returns the decided row with decided_at set", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "w1" }));
        const decided = yield* repo.decide("w1", "approved");
        expect(decided).not.toBeNull();
        expect(decided!.status).toBe("approved");
        expect(decided!.decided_at).not.toBeNull();
      })
    );
  });

  it("second decide on the same row returns null (guard, not error)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "w1" }));
        expect(yield* repo.decide("w1", "approved")).not.toBeNull();
        expect(yield* repo.decide("w1", "rejected")).toBeNull();
      })
    );
  });

  it("decide on an expired row returns null — expiry wins over a late decision", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "w1", expires_at: "2000-01-01 00:00:00" }));
        expect(yield* repo.expireIfDue("w1")).not.toBeNull();
        expect(yield* repo.decide("w1", "approved")).toBeNull();
      })
    );
  });
});

describe("HeraldPendingWritesRepo expireIfDue / sweepExpired", () => {
  it("expireIfDue flips only pending+due rows; future or non-pending → null", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "due", expires_at: "2000-01-01 00:00:00" }));
        yield* repo.insert(row({ id: "future", expires_at: "9999-01-01 00:00:00" }));
        const expired = yield* repo.expireIfDue("due");
        expect(expired!.status).toBe("expired");
        expect(yield* repo.expireIfDue("future")).toBeNull();
        expect(yield* repo.expireIfDue("due")).toBeNull(); // already expired
      })
    );
  });

  it("sweepExpired counts only due pending rows across batches", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "a", batch_id: "b1", expires_at: "2000-01-01 00:00:00" }));
        yield* repo.insert(row({ id: "b", batch_id: "b1", expires_at: "2000-01-02 00:00:00" }));
        yield* repo.insert(row({ id: "c", batch_id: "b2", expires_at: "9999-01-01 00:00:00" }));
        yield* repo.insert(row({ id: "d", batch_id: "b2", expires_at: "2000-01-01 00:00:00" }));
        seedDecided(db, "d", "rejected");
        expect(yield* repo.sweepExpired()).toBe(2);
        expect(yield* repo.sweepExpired()).toBe(0); // idempotent
      })
    );
  });
});

describe("HeraldPendingWritesRepo listByBatch / countByBatchRemaining", () => {
  it("listByBatch orders by seq ASC regardless of insert order", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "s2", batch_id: "b1", seq: 2 }));
        yield* repo.insert(row({ id: "s0", batch_id: "b1", seq: 0 }));
        yield* repo.insert(row({ id: "s1", batch_id: "b1", seq: 1 }));
        yield* repo.insert(row({ id: "other", batch_id: "b2", seq: 9 }));
        const rows = yield* repo.listByBatch("b1");
        expect(rows.map((r) => r.id)).toEqual(["s0", "s1", "s2"]);
      })
    );
  });

  it("countByBatchRemaining counts only pending rows in the batch", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "p1r", batch_id: "b1" }));
        yield* repo.insert(row({ id: "p2r", batch_id: "b1" }));
        yield* repo.insert(row({ id: "p3r", batch_id: "b1" }));
        seedDecided(db, "p2r", "approved");
        seedDecided(db, "p3r", "expired");
        yield* repo.insert(row({ id: "p4r", batch_id: "b2" }));
        expect(yield* repo.countByBatchRemaining("b1")).toBe(1);
        expect(yield* repo.countByBatchRemaining("empty")).toBe(0);
      })
    );
  });
});

describe("HeraldPendingWritesRepo markExecutionError", () => {
  it("records the error string on the row without touching status", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.insert(row({ id: "w1" }));
        seedDecided(db, "w1", "approved");
        yield* repo.markExecutionError("w1", "WIP_LIMIT: column at capacity");
        const got = yield* repo.getById("w1");
        expect(got!.execution_error).toBe("WIP_LIMIT: column at capacity");
        expect(got!.status).toBe("approved");
      })
    );
  });
});

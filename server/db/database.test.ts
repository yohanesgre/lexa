import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Context, Layer, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrate";
import { Sqlite, initSqlite, withTx, batch, run, queryAll, DbError, ConstraintViolation } from "./database";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const SEED = `
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Main', 0);
`;

const INSERT_TASK = (id: string, position: string) =>
  `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('${id}','p1','c1','s1','T','${position}')`;

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lexa-db-test-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  return path;
}

// Open via initSqlite (real PRAGMAs + chmod path); returns the Database.
function openDb(): Database {
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(tmpPath()))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("unique indexes", () => {
  it("rejects two tasks with the same (column_id, position)", () => {
    const db = openDb();
    db.exec(SEED);
    db.exec(INSERT_TASK("t1", "a0"));
    const result = Effect.runSync(
      Effect.either(run(db, INSERT_TASK("t2", "a0")))
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConstraintViolation);
      expect((result.left as ConstraintViolation).isPositionConflict).toBe(true);
    }
  });

  it("allows a different position in the same column", () => {
    const db = openDb();
    db.exec(SEED);
    db.exec(INSERT_TASK("t1", "a0"));
    const result = Effect.runSync(
      Effect.either(run(db, INSERT_TASK("t2", "a1")))
    );
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects a second task_github_issues row with the same issue_id", () => {
    const db = openDb();
    db.exec(SEED);
    db.exec(INSERT_TASK("t1", "a0"));
    db.exec(INSERT_TASK("t2", "a1"));
    db.exec("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES ('t1','ghi1',1,'r')");
    const result = Effect.runSync(
      Effect.either(
        run(db, "INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES (?,?,?,?)", "t2", "ghi1", 1, "r")
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConstraintViolation);
      expect((result.left as ConstraintViolation).isPositionConflict).toBe(false);
    }
    expect(count(db, "task_github_issues")).toBe(1);
  });
});

describe("withTx", () => {
  it("commits all writes in the wrapped effect", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        withTx(db, Effect.sync(() => {
          db.exec(INSERT_TASK("t1", "a0"));
          db.exec(INSERT_TASK("t2", "a1"));
        }))
      )
    );
    expect(Either.isRight(result)).toBe(true);
    expect(count(db, "tasks")).toBe(2);
  });

  it("rolls back on failure and resets tx depth", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        withTx(
          db,
          Effect.gen(function* () {
            db.exec(INSERT_TASK("t1", "a0"));
            yield* Effect.fail(new DbError({ message: "boom" }));
          })
        )
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(DbError);
    expect(count(db, "tasks")).toBe(0);
    // txDepth must be back to 0 — a fresh withTx still commits.
    const again = Effect.runSync(
      Effect.either(
        withTx(db, Effect.sync(() => db.exec(INSERT_TASK("t2", "a1"))))
      )
    );
    expect(Either.isRight(again)).toBe(true);
    expect(count(db, "tasks")).toBe(1);
  });

  it("supports nested withTx — inner participates in outer transaction", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        withTx(
          db,
          withTx(db, Effect.sync(() => db.exec(INSERT_TASK("t1", "a0"))))
        )
      )
    );
    expect(Either.isRight(result)).toBe(true);
    expect(count(db, "tasks")).toBe(1);
  });

  it("rolls back nested withTx when the outer effect fails", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        withTx(
          db,
          Effect.gen(function* () {
            yield* withTx(db, Effect.sync(() => db.exec(INSERT_TASK("t1", "a0"))));
            yield* Effect.fail(new DbError({ message: "boom" }));
          })
        )
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(count(db, "tasks")).toBe(0);
  });
});

describe("batch", () => {
  it("runs standalone inside its own transaction", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        batch(db, [
          { sql: INSERT_TASK("t1", "a0"), params: [] },
          { sql: INSERT_TASK("t2", "a1"), params: [] },
        ])
      )
    );
    expect(Either.isRight(result)).toBe(true);
    expect(count(db, "tasks")).toBe(2);
  });

  it("participates in an outer withTx (no nested transaction error)", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(
        withTx(
          db,
          batch(db, [
            { sql: INSERT_TASK("t1", "a0"), params: [] },
            { sql: INSERT_TASK("t2", "a1"), params: [] },
          ])
        )
      )
    );
    expect(Either.isRight(result)).toBe(true);
    expect(count(db, "tasks")).toBe(2);
  });

  it("surfaces ConstraintViolation and leaves no partial rows", () => {
    const db = openDb();
    db.exec(SEED);
    db.exec(INSERT_TASK("t1", "a0"));
    const result = Effect.runSync(
      Effect.either(
        batch(db, [
          { sql: INSERT_TASK("t2", "a1"), params: [] },
          { sql: INSERT_TASK("t3", "a0"), params: [] }, // position clash with t1
        ])
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConstraintViolation);
      expect((result.left as ConstraintViolation).isPositionConflict).toBe(true);
    }
    expect(count(db, "tasks")).toBe(1);
  });
});

describe("initSqlite pragmas", () => {
  it("sets WAL, foreign_keys and busy_timeout=5000", () => {
    const db = openDb();
    expect(Object.values(db.prepare("PRAGMA journal_mode").get() as object)[0]).toBe("wal");
    expect(Object.values(db.prepare("PRAGMA foreign_keys").get() as object)[0]).toBe(1);
    expect(Object.values(db.prepare("PRAGMA busy_timeout").get() as object)[0]).toBe(5000);
  });

  it("chmods db and -wal/-shm companions to 0600", () => {
    if (process.platform === "win32") return;
    const path = tmpPath();
    const ctx1 = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
    const db1 = Context.get(ctx1, Sqlite);
    dbs.push(db1);
    db1.exec("CREATE TABLE t (id)"); // forces -wal/-shm creation
    db1.exec("INSERT INTO t VALUES (1)");
    // Second open — companions exist now, initSqlite chmods them.
    const ctx2 = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
    const db2 = Context.get(ctx2, Sqlite);
    dbs.push(db2);
    for (const p of [path, path + "-wal", path + "-shm"]) {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });
});

describe("queryAll", () => {
  it("returns typed rows and maps DbError on failure", () => {
    const db = openDb();
    db.exec(SEED);
    const result = Effect.runSync(
      Effect.either(queryAll<{ id: string }>(db, "SELECT id FROM projects"))
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toEqual([{ id: "p1" }]);
    const bad = Effect.runSync(
      Effect.either(queryAll<{ id: string }>(db, "SELECT * FROM no_such_table"))
    );
    expect(Either.isLeft(bad)).toBe(true);
    if (Either.isLeft(bad)) expect(bad.left).toBeInstanceOf(DbError);
  });
});

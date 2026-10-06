import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "./bun-sqlite";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)");
  return db;
}

describe("bun:sqlite synthesis primitives", () => {
  it("RETURNING statements expose non-empty columnNames; all() writes and returns rows", () => {
    const db = makeDb();
    try {
      const stmt = db.prepare("INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v");
      expect(stmt.columnNames.length).toBeGreaterThan(0);
      const rows = stmt.all("a", 1) as Array<{ id: string; v: number }>;
      expect(rows).toEqual([{ id: "a", v: 1 }]);
      expect(db.prepare("SELECT id, v FROM t WHERE id = ?").get("a")).toEqual({ id: "a", v: 1 });
    } finally {
      db.close();
    }
  });

  it("non-returning statements expose empty columnNames; run() reports changes + lastInsertRowid", () => {
    const db = makeDb();
    try {
      const stmt = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
      expect(stmt.columnNames).toEqual([]);
      const r = stmt.run("b", 2);
      expect(r.changes).toBe(1);
      expect(r.lastInsertRowid).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe("bun-sqlite driver statement cache", () => {
  it("reuses the same statement instance for identical SQL and isolates distinct SQL", () => {
    const db = makeDb();
    try {
      const driver = createBunSqliteDriver(db);
      const a = driver.prepare("SELECT id, v FROM t WHERE id = ?");
      const b = driver.prepare("SELECT id, v FROM t WHERE id = ?");
      expect(a).toBe(b);
      expect(driver.prepare("SELECT id FROM t WHERE id = ?")).not.toBe(a);
    } finally {
      db.close();
    }
  });

  it("cached statement yields the same result as a fresh prepare", async () => {
    const db = makeDb();
    try {
      const driver = createBunSqliteDriver(db);
      await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
      const sql = "SELECT id, v FROM t WHERE id = ?";
      await driver.prepare(sql).first("a");
      const cached = await driver.prepare(sql).first("a");
      const fresh = db.prepare(sql).get("a");
      expect(cached).toEqual(fresh);
    } finally {
      db.close();
    }
  });

  it("cached placeholder statement throws on param-count mismatch instead of reusing prior bindings", async () => {
    const db = makeDb();
    try {
      const driver = createBunSqliteDriver(db);
      await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
      const sql = "SELECT id, v FROM t WHERE id = ? AND v = ?";
      await driver.prepare(sql).first("a", 1);
      expect(() => driver.prepare(sql).first()).toThrow("bun-sqlite driver: param count mismatch");
      expect(() => driver.prepare(sql).first("a")).toThrow("bun-sqlite driver: param count mismatch");
      expect(() => driver.prepare(sql).all("a", 1, 2)).toThrow("bun-sqlite driver: param count mismatch");
    } finally {
      db.close();
    }
  });

  it("close() clears the statement cache (no stale wrappers after native finalization)", () => {
    const db = makeDb();
    const driver = createBunSqliteDriver(db);
    driver.prepare("SELECT id, v FROM t WHERE id = ?");
    driver.close();
    expect(() => driver.prepare("SELECT id, v FROM t WHERE id = ?")).toThrow();
  });

  it("batch() reuses cached statements and preserves positional results across calls", async () => {
    const db = makeDb();
    try {
      const driver = createBunSqliteDriver(db);
      const stmts = [
        { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", 1] },
        { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["b", 2] },
      ];
      const first = await driver.batch(stmts);
      const second = await driver.batch([{ sql: "SELECT id, v FROM t ORDER BY id", params: [] }]);
      expect(first.map((r) => r.changes)).toEqual([1, 1]);
      expect(second[0]!.results).toEqual([
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it("batch() applies the arity guard to raw statements and keeps correct-arity batches working", async () => {
    const db = makeDb();
    try {
      const driver = createBunSqliteDriver(db);
      await expect(
        driver.batch([{ sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a"] }])
      ).rejects.toThrow("bun-sqlite driver: param count mismatch");

      const sql = "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v";
      const results = await driver.batch([
        { sql, params: ["a", 1] },
        { sql, params: ["b", 2] },
      ]);
      expect(results).toEqual([
        { results: [{ id: "a", v: 1 }], changes: 1 },
        { results: [{ id: "b", v: 2 }], changes: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});

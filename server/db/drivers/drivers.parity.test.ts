import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import type {
  D1BatchItem,
  D1Like,
  D1PreparedLike,
} from "./d1";
import { createD1Driver } from "./d1";
import { createBunSqliteDriver } from "./bun-sqlite";
import { BatchTimeout, DbError, type DbDriver } from "../driver";

const SCHEMA = "CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

function makeD1Like(db: Database): D1Like {
  return {
    prepare(query: string): D1PreparedLike {
      const stmt = db.prepare(query);
      let bound: unknown[] = [];
      const self: D1PreparedLike = {
        bind(...params: unknown[]) {
          bound = params;
          return self;
        },
        async all<T = Record<string, unknown>>() {
          return { results: stmt.all(...bound) as T[], success: true, meta: {} };
        },
        async first<T = Record<string, unknown>>() {
          return ((stmt.get(...bound) as T | null | undefined) ?? null) as T | null;
        },
        async run() {
          const r = stmt.run(...bound);
          return { success: true, meta: { changes: r.changes } };
        },
      };
      return self;
    },
    async batch(statements: D1BatchItem[]) {
      db.transaction(() => {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
      })();
      return { length: statements.length, duration: 0, results: [], success: true };
    },
  };
}

function count(driver: DbDriver) {
  return driver
    .prepare("SELECT COUNT(*) AS n FROM t")
    .first<{ n: number }>()
    .then((r) => r!.n);
}

function conformance(label: string, make: () => { driver: DbDriver; close: () => void }) {
  describe(`parity:${label}`, () => {
    it("insert + all + first round-trip with bound params", async () => {
      const { driver, close } = make();
      try {
        await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
        await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("b", 2);
        const rows = await driver.prepare("SELECT id, v FROM t ORDER BY id").all<{ id: string; v: number }>();
        expect(rows).toEqual([
          { id: "a", v: 1 },
          { id: "b", v: 2 },
        ]);
        expect(await driver.prepare("SELECT id, v FROM t WHERE id = ?").first("a")).toEqual({ id: "a", v: 1 });
      } finally {
        close();
      }
    });

    it("first() returns null on a missing row", async () => {
      const { driver, close } = make();
      try {
        expect(await driver.prepare("SELECT id FROM t WHERE id = ?").first("nope")).toBeNull();
      } finally {
        close();
      }
    });

    it("run() reports changes; no-match update reports 0", async () => {
      const { driver, close } = make();
      try {
        await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
        expect((await driver.prepare("UPDATE t SET v = ? WHERE id = ?").run(9, "a")).changes).toBe(1);
        expect((await driver.prepare("UPDATE t SET v = ? WHERE id = ?").run(9, "ghost")).changes).toBe(0);
      } finally {
        close();
      }
    });

    it("batch() commits every statement", async () => {
      const { driver, close } = make();
      try {
        await driver.batch([
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", 1] },
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["b", 2] },
        ]);
        expect(await count(driver)).toBe(2);
      } finally {
        close();
      }
    });

    it("batch() is atomic: a failing statement rolls back the whole array", async () => {
      const { driver, close } = make();
      try {
        await expect(
          driver.batch([
            { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", 1] },
            { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", 2] },
          ]),
        ).rejects.toThrow();
        expect(await count(driver)).toBe(0);
      } finally {
        close();
      }
    });

    it("bad SQL surfaces an error (sync throw or rejection — callers must handle both)", async () => {
      const { driver, close } = make();
      try {
        await expect(
          Promise.resolve().then(() => driver.prepare("SELECT * FROM no_such_table").all()),
        ).rejects.toThrow();
      } finally {
        close();
      }
    });
  });
}

conformance("bun-sqlite", () => {
  const db = makeDb();
  return { driver: createBunSqliteDriver(db), close: () => db.close() };
});

conformance("d1", () => {
  const db = makeDb();
  return { driver: createD1Driver(makeD1Like(db)), close: () => db.close() };
});

describe("bun-sqlite driver specifics", () => {
  it("run() surfaces lastInsertRowid", async () => {
    const db = makeDb();
    const driver = createBunSqliteDriver(db);
    try {
      const r = await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
      expect(r.lastInsertRowid).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("transaction() commits and rolls back", async () => {
    const db = makeDb();
    const driver = createBunSqliteDriver(db);
    try {
      await driver.transaction(async (tx) => {
        await tx.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
      });
      expect(await count(driver)).toBe(1);
      await expect(
        driver.transaction(async (tx) => {
          await tx.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("b", 2);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await count(driver)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("nested transaction() participates in the outer tx", async () => {
    const db = makeDb();
    const driver = createBunSqliteDriver(db);
    try {
      await driver.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
        });
      });
      expect(await count(driver)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("d1 driver specifics", () => {
  it("run() leaves lastInsertRowid undefined (callers must use RETURNING)", async () => {
    const db = makeDb();
    const driver = createD1Driver(makeD1Like(db));
    try {
      const r = await driver.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", 1);
      expect(r.lastInsertRowid).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("transaction() throws: atomicity is batch() only", async () => {
    const db = makeDb();
    const driver = createD1Driver(makeD1Like(db));
    try {
      await expect(driver.transaction(async () => 1)).rejects.toBeInstanceOf(DbError);
    } finally {
      db.close();
    }
  });

  it("batch() maps success=false to DbError", async () => {
    const d1: D1Like = {
      ...makeD1Like(makeDb()),
      batch: async (stmts: D1BatchItem[]) => ({
        length: stmts.length,
        duration: 1,
        results: [],
        success: false,
      }),
    };
    await expect(createD1Driver(d1).batch([{ sql: "SELECT 1", params: [] }])).rejects.toBeInstanceOf(DbError);
  });

  it("batch() maps an over-budget duration to BatchTimeout", async () => {
    const d1: D1Like = {
      ...makeD1Like(makeDb()),
      batch: async (stmts: D1BatchItem[]) => ({
        length: stmts.length,
        duration: 29_000,
        results: [],
        success: true,
      }),
    };
    await expect(createD1Driver(d1).batch([{ sql: "SELECT 1", params: [] }])).rejects.toBeInstanceOf(BatchTimeout);
  });

  it("close() is a no-op", () => {
    const db = makeDb();
    try {
      expect(() => createD1Driver(makeD1Like(db)).close()).not.toThrow();
    } finally {
      db.close();
    }
  });
});

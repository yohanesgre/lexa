import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import type {
  D1BatchItem,
  D1Like,
  D1PreparedLike,
} from "./d1";
import { createD1Driver } from "./d1";
import { createBunSqliteDriver } from "./bun-sqlite";
import { type DbDriver } from "../driver";

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
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return self;
    },
    async batch(statements: D1BatchItem[]) {
      return db.transaction(() =>
        statements.map((s) => {
          const stmt = db.prepare(s.sql);
          if (stmt.columnNames.length > 0) {
            const rows = stmt.all(...(s.params ?? []));
            const last = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
            return { success: true, results: rows, meta: { changes: rows.length, duration: 0, last_row_id: last } };
          }
          const r = stmt.run(...(s.params ?? []));
          return {
            success: true,
            results: [],
            meta: { changes: r.changes, duration: 0, last_row_id: Number(r.lastInsertRowid) },
          };
        }),
      )();
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

    it("batch() returns positional results: RETURNING rows and per-statement changes", async () => {
      const { driver, close } = make();
      try {
        const [ins, upd, del] = await driver.batch([
          { sql: "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", params: ["a", 1] },
          { sql: "UPDATE t SET v = 2 WHERE id = 'a'", params: [] },
          { sql: "DELETE FROM t WHERE id = 'nope'", params: [] },
        ]);
        expect(ins!.results).toEqual([{ id: "a", v: 1 }]);
        expect(upd!.changes).toBe(1);
        expect(upd!.results).toEqual([]);
        expect(del!.changes).toBe(0);
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

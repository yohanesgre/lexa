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

// Minimal live-source tables plus 0033's `assistant_embeddings` shape and its
// three AFTER DELETE triggers, so delete-cleanup parity runs against the real
// SQL semantics (the migration file's full DDL is covered by migrate.test.ts).
const SCHEMA = `
  CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE wiki_pages (id TEXT PRIMARY KEY);
  CREATE TABLE tasks (id TEXT PRIMARY KEY);
  CREATE TABLE project_memory (id TEXT PRIMARY KEY);
  CREATE TABLE assistant_embeddings (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('wiki','task','memory')),
    ref_id          TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    embedding       BLOB,
    embedding_model TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, ref_id, chunk_index)
  );
  CREATE TRIGGER assistant_embeddings_wiki_delete AFTER DELETE ON wiki_pages BEGIN
    DELETE FROM assistant_embeddings WHERE kind = 'wiki' AND ref_id = OLD.id;
  END;
  CREATE TRIGGER assistant_embeddings_task_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM assistant_embeddings WHERE kind = 'task' AND ref_id = OLD.id;
  END;
  CREATE TRIGGER assistant_embeddings_memory_delete AFTER DELETE ON project_memory BEGIN
    DELETE FROM assistant_embeddings WHERE kind = 'memory' AND ref_id = OLD.id;
  END;
`;

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

    it("assistant_embeddings delete triggers drop the source's chunks, leaving other kinds", async () => {
      const { driver, close } = make();
      try {
        await driver.prepare("INSERT INTO wiki_pages (id) VALUES (?)").run("w1");
        await driver.prepare("INSERT INTO project_memory (id) VALUES (?)").run("m1");
        const insertChunk = `INSERT INTO assistant_embeddings (id, project_id, kind, ref_id, chunk_index, content, embedding_model)
                             VALUES (?, 'p1', ?, ?, ?, ?, 'model')`;
        await driver.batch([
          { sql: insertChunk, params: ["e1", "wiki", "w1", 0, "wiki chunk 0"] },
          { sql: insertChunk, params: ["e2", "wiki", "w1", 1, "wiki chunk 1"] },
          { sql: insertChunk, params: ["e3", "memory", "m1", 0, "memory chunk"] },
        ]);
        expect((await driver.prepare("DELETE FROM wiki_pages WHERE id = ?").run("w1")).changes).toBe(1);
        const rows = await driver.prepare("SELECT id, kind FROM assistant_embeddings ORDER BY id").all<{ id: string; kind: string }>();
        expect(rows).toEqual([{ id: "e3", kind: "memory" }]);
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

import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";

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

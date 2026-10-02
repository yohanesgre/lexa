import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import {
  Db,
  DbBunLive,
  batch,
  batchResults,
  requireRow,
  mapDbError,
  queryAll,
  queryFirst,
  run,
  runReturning,
  withTx,
  ConstraintViolation,
  DbError,
  RowNotFound,
} from "./db";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import type { DbDriver } from "./driver";

function memDriver(): { driver: DbDriver; close: () => void } {
  const native = new Database(":memory:");
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const driver = createBunSqliteDriver(native);
  return { driver, close: () => native.close() };
}

const runEff = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never>);

describe("mapDbError", () => {
  it("maps UNIQUE failures to ConstraintViolation, position conflicts flagged", () => {
    const pos = mapDbError(new Error("UNIQUE constraint failed: tasks.column_id, tasks.position"));
    expect(pos).toBeInstanceOf(ConstraintViolation);
    expect((pos as ConstraintViolation).isPositionConflict).toBe(true);
    const other = mapDbError(new Error("UNIQUE constraint failed: projects.slug"));
    expect(other).toBeInstanceOf(ConstraintViolation);
    expect((other as ConstraintViolation).isPositionConflict).toBe(false);
    const plain = mapDbError(new Error("no such table: nope"));
    expect(plain).toBeInstanceOf(DbError);
  });
});

describe("async wrappers over the bun driver", () => {
  it("queryAll/queryFirst round-trip; first() null → RowNotFound", async () => {
    const { driver, close } = memDriver();
    try {
      await runEff(run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "a", "1"));
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t"))).toEqual([{ id: "a" }]);
      expect(await runEff(queryFirst<{ id: string }>(driver, "SELECT id FROM t WHERE id = ?", "a"))).toEqual({ id: "a" });
      const missing = await Effect.runPromise(Effect.either(queryFirst(driver, "SELECT id FROM t WHERE id = ?", "zzz")));
      expect(missing._tag).toBe("Left");
      if (missing._tag === "Left") expect(missing.left).toBeInstanceOf(RowNotFound);
    } finally {
      close();
    }
  });

  it("run returns changes; UNIQUE → ConstraintViolation", async () => {
    const { driver, close } = memDriver();
    try {
      expect(await runEff(run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "a", "1"))).toBe(1);
      expect(await runEff(run(driver, "UPDATE t SET v = ? WHERE id = ?", "2", "missing"))).toBe(0);
      const dup = await Effect.runPromise(Effect.either(run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "a", "x")));
      expect(dup._tag).toBe("Left");
      if (dup._tag === "Left") {
        expect(dup.left).toBeInstanceOf(ConstraintViolation);
        expect((dup.left as ConstraintViolation).isPositionConflict).toBe(false);
      }
    } finally {
      close();
    }
  });

  it("runReturning surfaces INSERT...RETURNING rows and constraint errors", async () => {
    const { driver, close } = memDriver();
    try {
      const row = await runEff(runReturning<{ id: string; v: string }>(driver, "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", "a", "1"));
      expect(row).toEqual({ id: "a", v: "1" });
      const dup = await Effect.runPromise(Effect.either(runReturning(driver, "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id", "a", "2")));
      expect(dup._tag).toBe("Left");
      if (dup._tag === "Left") expect(dup.left).toBeInstanceOf(ConstraintViolation);
    } finally {
      close();
    }
  });

  it("batch is atomic: a failing statement rolls back the whole array", async () => {
    const { driver, close } = memDriver();
    try {
      const res = await Effect.runPromise(Effect.either(
        batch(driver, [
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", "1"] },
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", "dup"] },
        ])
      ));
      expect(res._tag).toBe("Left");
      expect(await runEff(queryAll(driver, "SELECT id FROM t"))).toEqual([]);
    } finally {
      close();
    }
  });

  it("withTx commits on success and rolls back on failure", async () => {
    const { driver, close } = memDriver();
    try {
      await runEff(withTx(driver, run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "a", "1")));
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t"))).toEqual([{ id: "a" }]);
      const failed = await Effect.runPromise(Effect.either(
        withTx(driver, Effect.gen(function* () {
          yield* run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "b", "2");
          return yield* Effect.fail(new DbError({ message: "boom" }));
        }))
      ));
      expect(failed._tag).toBe("Left");
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t ORDER BY id"))).toEqual([{ id: "a" }]);
    } finally {
      close();
    }
  });

  it("nested withTx participates in the outer transaction; batch joins it", async () => {
    const { driver, close } = memDriver();
    try {
      await runEff(withTx(driver, Effect.gen(function* () {
        yield* run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "a", "1");
        yield* withTx(driver, batch(driver, [{ sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["b", "2"] }]));
      })));
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t ORDER BY id"))).toEqual([{ id: "a" }, { id: "b" }]);
      const failed = await Effect.runPromise(Effect.either(
        withTx(driver, Effect.gen(function* () {
          yield* withTx(driver, run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "c", "3"));
          return yield* Effect.fail(new DbError({ message: "boom" }));
        }))
      ));
      expect(failed._tag).toBe("Left");
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t ORDER BY id"))).toEqual([{ id: "a" }, { id: "b" }]);
    } finally {
      close();
    }
  });

  it("batchResults returns positional results (incl. inside a Bun withTx)", async () => {
    const { driver, close } = memDriver();
    try {
      const [ins, upd, del] = await runEff(batchResults(driver, [
        { sql: "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", params: ["a", "1"] },
        { sql: "UPDATE t SET v = ? WHERE id = ?", params: ["2", "a"] },
        { sql: "DELETE FROM t WHERE id = ?", params: ["nope"] },
      ]));
      expect(ins!.results).toEqual([{ id: "a", v: "1" }]);
      expect(ins!.changes).toBe(1);
      expect(upd!.changes).toBe(1);
      expect(upd!.results).toEqual([]);
      expect(del!.changes).toBe(0);

      await runEff(withTx(driver, Effect.gen(function* () {
        const [row] = yield* batchResults(driver, [
          { sql: "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", params: ["b", "2"] },
        ]);
        expect(row!.results).toEqual([{ id: "b", v: "2" }]);
        yield* run(driver, "INSERT INTO t (id, v) VALUES (?, ?)", "c", "3");
      })));
      expect(await runEff(queryAll<{ id: string }>(driver, "SELECT id FROM t ORDER BY id"))).toEqual([
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ]);
    } finally {
      close();
    }
  });

  it("batch-only driver (D1 shape): batch() rolls back atomically; withTx bodies do NOT roll back", async () => {
    const { driver: bun, close } = memDriver();
    const d1shaped: DbDriver = { ...bun, supportsInteractiveTx: false };
    try {
      const res = await Effect.runPromise(Effect.either(
        batch(d1shaped, [
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", "1"] },
          { sql: "INSERT INTO t (id, v) VALUES (?, ?)", params: ["a", "dup"] },
        ])
      ));
      expect(res._tag).toBe("Left");
      expect(await runEff(queryAll(d1shaped, "SELECT id FROM t"))).toEqual([]);

      const failed = await Effect.runPromise(Effect.either(
        withTx(d1shaped, Effect.gen(function* () {
          yield* run(d1shaped, "INSERT INTO t (id, v) VALUES (?, ?)", "b", "2");
          return yield* Effect.fail(new DbError({ message: "boom" }));
        }))
      ));
      expect(failed._tag).toBe("Left");
      expect(await runEff(queryAll(d1shaped, "SELECT id FROM t"))).toEqual([{ id: "b" }]);
    } finally {
      close();
    }
  });

  it("requireRow returns the RETURNING row and fails DbError when absent", async () => {
    const { driver, close } = memDriver();
    try {
      const [ins] = await runEff(batchResults(driver, [
        { sql: "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", params: ["a", "1"] },
      ]));
      expect(await runEff(requireRow<{ id: string; v: string }>(ins, "test.insert"))).toEqual({ id: "a", v: "1" });

      const empty = await Effect.runPromise(Effect.either(requireRow({ results: [], changes: 0 }, "test.empty")));
      expect(empty._tag).toBe("Left");
      if (empty._tag === "Left") {
        expect(empty.left).toBeInstanceOf(DbError);
        expect(empty.left.message).toContain("test.empty");
      }

      const missing = await Effect.runPromise(Effect.either(requireRow(undefined, "test.missing")));
      expect(missing._tag).toBe("Left");
      if (missing._tag === "Left") expect(missing.left).toBeInstanceOf(DbError);
    } finally {
      close();
    }
  });

  it("DbBunLive provides the Db tag from a raw Database", async () => {
    const native = new Database(":memory:");
    try {
      const eff = Effect.map(Effect.serviceOption(Db), (opt) => opt._tag);
      expect(await Effect.runPromise(Effect.provide(eff, DbBunLive(native)))).toBe("Some");
    } finally {
      native.close();
    }
  });
});

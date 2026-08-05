import { Context, Effect, Layer, Data } from "effect";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{ message: string; isPositionConflict: boolean }> {}

export class Sqlite extends Context.Tag("Lexa/Sqlite")<Sqlite, Database>() {}

// Transaction nesting depth. Single-threaded server — a plain counter is safe.
// withTx()/batch() check it to avoid BEGIN/transaction inside an open tx
// (SQLite forbids nested transactions on one connection).
let txDepth = 0;

export function initSqlite(dbPath: string): Layer.Layer<Sqlite> {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // DB file + WAL/SHM companions hold task/wiki content — keep them user-only.
  try { chmodSync(dbPath, 0o600); } catch {}
  for (const suffix of ["-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) { try { chmodSync(p, 0o600); } catch {} }
  }
  return Layer.succeed(Sqlite, db);
}

export function queryAll<T>(db: Database, sql: string, ...params: unknown[]): Effect.Effect<T[], DbError> {
  return Effect.try({
    try: () => db.prepare(sql).all(...params) as T[],
    catch: (e) => new DbError({ message: String(e), cause: e }),
  });
}

export function queryFirst<T>(db: Database, sql: string, ...params: unknown[]): Effect.Effect<T, RowNotFound | DbError> {
  return Effect.try({
    try: () => db.prepare(sql).get(...params) as T | null,
    catch: (e) => new DbError({ message: String(e), cause: e }),
  }).pipe(
    Effect.flatMap((row) => row === null ? Effect.fail(new RowNotFound({ table: "unknown" })) : Effect.succeed(row))
  );
}

export function run(db: Database, sql: string, ...params: unknown[]): Effect.Effect<number, ConstraintViolation | DbError> {
  return Effect.try({
    try: () => db.prepare(sql).run(...params).changes as number,
    catch: (e) => {
      const msg = String(e);
      // bun:sqlite reports constraints as "SQLiteError: UNIQUE constraint
      // failed: projects.slug" / "FOREIGN KEY constraint failed" — the
      // literal SQLITE_CONSTRAINT string never appears.
      if (msg.includes("SQLITE_CONSTRAINT") || /constraint failed/i.test(msg)) {
        return new ConstraintViolation({ message: msg, isPositionConflict: /tasks\.column_id.*tasks\.position/.test(msg) });
      }
      return new DbError({ message: msg, cause: e });
    },
  });
}

export function batch(db: Database, stmts: { sql: string; params: unknown[] }[]): Effect.Effect<void, ConstraintViolation | DbError> {
  return Effect.try({
    try: () => {
      if (txDepth > 0) {
        // Inside an open withTx — run directly, participate in the outer tx.
        for (const { sql, params } of stmts) db.prepare(sql).run(...params);
      } else {
        db.transaction(() => { for (const { sql, params } of stmts) db.prepare(sql).run(...params); })();
      }
    },
    catch: (e) => {
      const msg = String(e);
      if (msg.includes("SQLITE_CONSTRAINT") || /constraint failed/i.test(msg)) {
        return new ConstraintViolation({ message: msg, isPositionConflict: /tasks\.column_id.*tasks\.position/.test(msg) });
      }
      return new DbError({ message: msg, cause: e });
    },
  });
}

export function withTx<A, E>(db: Database, effect: Effect.Effect<A, E, never>): Effect.Effect<A, E, never> {
  return Effect.suspend(() => {
    if (txDepth > 0) {
      // Nested withTx — participate in the outer transaction.
      return effect;
    }
    txDepth++;
    try {
      db.exec("BEGIN");
    } catch (e) {
      txDepth--;
      throw e;
    }
    return effect.pipe(
      Effect.tap(() => Effect.sync(() => db.exec("COMMIT"))),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
        }).pipe(Effect.zipRight(Effect.failCause(cause)))
      ),
      Effect.onExit(() => Effect.sync(() => { txDepth--; }))
    );
  });
}

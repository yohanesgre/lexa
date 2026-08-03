import { Context, Effect, Layer, Data } from "effect";
import { Database } from "bun:sqlite";

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{ message: string; isPositionConflict: boolean }> {}

export class Sqlite extends Context.Tag("Lexa/Sqlite")<Sqlite, Database>() {}

export function initSqlite(dbPath: string): Layer.Layer<Sqlite> {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
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
      db.transaction(() => { for (const { sql, params } of stmts) db.prepare(sql).run(...params); })();
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

import { Context, Effect, Layer, Data } from "effect";
import { env as cfEnv } from "cloudflare:workers";

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{
  message: string;
  isPositionConflict: boolean;
}> {}

export class D1 extends Context.Tag("Lexa/D1")<D1, D1Database>() {}

export function setD1Binding(db: D1Database): void {
  globalD1 = db;
}

let globalD1: D1Database | null = null;

function resolveDb(): D1Database {
  if (globalD1) return globalD1;
  const db = (cfEnv as unknown as Env).DB;
  if (!db) throw new Error("D1 binding DB unavailable");
  return db;
}

const d1Proxy = new Proxy({} as D1Database, {
  get(_target, prop: string) {
    const db = resolveDb();
    const value = (db as unknown as Record<string, unknown>)[prop];
    if (typeof value === "function") return (value as Function).bind(db);
    return value;
  },
});

export const d1Live: Layer.Layer<D1> = Layer.succeed(D1, d1Proxy);

function isConstraintError(e: unknown): boolean {
  return e instanceof Error && /SQLITE_CONSTRAINT/.test(e.message);
}

function isPositionConflict(e: unknown): boolean {
  return e instanceof Error && /tasks\.column_id,\s*tasks\.position/.test(e.message);
}

function toDbError(e: unknown): DbError {
  return new DbError({ message: e instanceof Error ? e.message : String(e), cause: e });
}

function toConstraintOrDbError(e: unknown): ConstraintViolation | DbError {
  if (isConstraintError(e)) {
    return new ConstraintViolation({
      message: e instanceof Error ? e.message : String(e),
      isPositionConflict: isPositionConflict(e),
    });
  }
  return toDbError(e);
}

export function queryAll<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T[], DbError> {
  return Effect.tryPromise({
    try: () =>
      db
        .prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>()
        .then((r) => r.results as T[]),
    catch: toDbError,
  });
}

export function queryFirst<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T, RowNotFound | DbError> {
  return Effect.tryPromise({
    try: () => db.prepare(sql).bind(...params).first<T | null>(),
    catch: toDbError,
  }).pipe(Effect.flatMap((row) => (row === null ? Effect.fail(new RowNotFound({ table: "unknown" })) : Effect.succeed(row))));
}

export function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Effect.Effect<number, ConstraintViolation | DbError> {
  return Effect.tryPromise({
    try: () =>
      db
        .prepare(sql)
        .bind(...params)
        .run()
        .then((r) => r.meta.changes),
    catch: (e) => toConstraintOrDbError(e),
  });
}

export function batch(
  db: D1Database,
  stmts: { sql: string; params: unknown[] }[]
): Effect.Effect<void, ConstraintViolation | DbError> {
  return Effect.tryPromise({
    try: () => db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params))),
    catch: (e) => toConstraintOrDbError(e),
  }).pipe(Effect.map(() => undefined));
}

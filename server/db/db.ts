import { Context, Effect, Layer } from "effect";
import type { Database } from "bun:sqlite";
import type { DbDriver, DbStmt, LexaRow, SqlParam } from "./driver";
import { ConstraintViolation, DbError, RowNotFound } from "./driver";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import type { D1Like } from "./drivers/d1";
import { createD1Driver } from "./drivers/d1";

export { ConstraintViolation, DbError, RowNotFound };
export type { DbDriver, DbStmt, LexaRow, SqlParam };

export class Db extends Context.Tag("Lexa/Db")<Db, DbDriver>() {}

export const DbBunLive = (db: Database): Layer.Layer<Db> =>
  Layer.succeed(Db, createBunSqliteDriver(db));

export const DbD1Live = (d1: D1Like): Layer.Layer<Db> =>
  Layer.succeed(Db, createD1Driver(d1));

export function mapDbError(e: unknown): ConstraintViolation | DbError {
  const msg = String(e);
  if (e instanceof ConstraintViolation || e instanceof DbError) return e;
  if (msg.includes("SQLITE_CONSTRAINT") || /constraint failed/i.test(msg)) {
    return new ConstraintViolation({
      message: msg,
      isPositionConflict: /tasks\.column_id.*tasks\.position/.test(msg),
    });
  }
  return new DbError({ message: msg, cause: e });
}

const stmtOf = (driver: DbDriver, sql: string): Effect.Effect<DbStmt, DbError> =>
  Effect.try({
    try: () => driver.prepare(sql),
    catch: (e) => beginTxError(e),
  });

function beginTxError(e: unknown): DbError {
  const mapped = mapDbError(e);
  return mapped instanceof ConstraintViolation
    ? new DbError({ message: mapped.message, cause: e })
    : mapped;
}

export function queryAll<T>(
  driver: DbDriver,
  sql: string,
  ...params: SqlParam[]
): Effect.Effect<T[], DbError>;
export function queryAll<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T[], DbError>;
export function queryAll<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T[], DbError> {
  return stmtOf(driver, sql).pipe(
    Effect.flatMap((stmt) =>
      Effect.tryPromise({
        try: () => stmt.all(...(params as SqlParam[])).then((rows) => rows as unknown as T[]),
        catch: (e) => new DbError({ message: String(e), cause: e }),
      })
    )
  );
}

export function queryFirst<T>(
  driver: DbDriver,
  sql: string,
  ...params: SqlParam[]
): Effect.Effect<T, RowNotFound | DbError>;
export function queryFirst<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T, RowNotFound | DbError>;
export function queryFirst<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T, RowNotFound | DbError> {
  return stmtOf(driver, sql).pipe(
    Effect.flatMap((stmt) =>
      Effect.tryPromise({
        try: () => stmt.first(...(params as SqlParam[])).then((row) => row as unknown as T | null),
        catch: (e) => new DbError({ message: String(e), cause: e }),
      })
    ),
    Effect.flatMap((row) =>
      row === null ? Effect.fail(new RowNotFound({ table: "unknown" })) : Effect.succeed(row)
    )
  );
}

export function runReturning<T>(
  driver: DbDriver,
  sql: string,
  ...params: SqlParam[]
): Effect.Effect<T, RowNotFound | ConstraintViolation | DbError>;
export function runReturning<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T, RowNotFound | ConstraintViolation | DbError>;
export function runReturning<T>(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<T, RowNotFound | ConstraintViolation | DbError> {
  return stmtOf(driver, sql).pipe(
    Effect.flatMap((stmt) =>
      Effect.tryPromise({
        try: () => stmt.first(...(params as SqlParam[])).then((row) => row as unknown as T | null),
        catch: (e) => mapDbError(e),
      })
    ),
    Effect.flatMap((row) =>
      row === null ? Effect.fail(new RowNotFound({ table: "unknown" })) : Effect.succeed(row)
    )
  );
}

export function run(
  driver: DbDriver,
  sql: string,
  ...params: SqlParam[]
): Effect.Effect<number, ConstraintViolation | DbError>;
export function run(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<number, ConstraintViolation | DbError>;
export function run(
  driver: DbDriver,
  sql: string,
  ...params: unknown[]
): Effect.Effect<number, ConstraintViolation | DbError> {
  return stmtOf(driver, sql).pipe(
    Effect.flatMap((stmt) =>
      Effect.tryPromise({
        try: () => stmt.run(...(params as SqlParam[])).then((r) => r.changes),
        catch: (e) => mapDbError(e),
      })
    )
  );
}

export interface BatchStmt {
  sql: string;
  params: SqlParam[];
}

const txDepth = new WeakMap<DbDriver, number>();

export function batch(
  driver: DbDriver,
  stmts: BatchStmt[]
): Effect.Effect<void, ConstraintViolation | DbError> {
  if ((txDepth.get(driver) ?? 0) > 0) {
    return Effect.gen(function* () {
      for (const s of stmts) yield* run(driver, s.sql, ...s.params);
    });
  }
  return Effect.tryPromise({
    try: () => driver.batch(stmts),
    catch: (e) => mapDbError(e),
  });
}

export function withTx<A, E, R>(
  driver: DbDriver,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | DbError, R> {
  return Effect.suspend(() => {
    if ((txDepth.get(driver) ?? 0) > 0) return effect;
    if (driver.supportsInteractiveTx === false) return effect;
    return Effect.tryPromise({
      try: () => driver.prepare("BEGIN IMMEDIATE").run(),
      catch: (e) => beginTxError(e),
    }).pipe(
      Effect.flatMap(() => {
        txDepth.set(driver, 1);
        return effect.pipe(
          Effect.tap(() =>
            Effect.tryPromise({
              try: () => driver.prepare("COMMIT").run(),
              catch: (e) => beginTxError(e),
            })
          ),
          Effect.catchAllCause((cause) =>
            Effect.tryPromise({
              try: () => driver.prepare("ROLLBACK").run(),
              catch: (e) => new DbError({ message: String(e), cause: e }),
            }).pipe(Effect.zipRight(Effect.failCause(cause)))
          ),
          Effect.onExit(() => Effect.sync(() => { txDepth.set(driver, 0); }))
        );
      })
    );
  });
}

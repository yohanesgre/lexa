import { Context, Effect, Layer } from "effect";
import type { Database } from "bun:sqlite";
import type { BatchStmtResult, DbDriver, DbStmt, LexaRow, SqlParam } from "./driver";
import { ConstraintViolation, DbError, RowNotFound, mapDbError } from "./driver";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import type { D1Like } from "./drivers/d1";
import { createD1Driver } from "./drivers/d1";

export { ConstraintViolation, DbError, RowNotFound };
export { mapDbError } from "./driver";
export type { BatchStmtResult, DbDriver, DbStmt, LexaRow, SqlParam };

export class Db extends Context.Tag("Lexa/Db")<Db, DbDriver>() {}

export const DbBunLive = (db: Database): Layer.Layer<Db> =>
  Layer.succeed(Db, createBunSqliteDriver(db));

export const DbD1Live = (d1: D1Like): Layer.Layer<Db> =>
  Layer.succeed(Db, createD1Driver(d1));

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

/** Result-bearing batch. On a nested (`withTx`) Bun path the statements run
 *  sequentially with the same synthesis as the driver; otherwise the driver's
 *  atomic `batch()` is used and its positional results returned. */
export function batchResults(
  driver: DbDriver,
  stmts: BatchStmt[]
): Effect.Effect<BatchStmtResult[], ConstraintViolation | DbError> {
  if ((txDepth.get(driver) ?? 0) > 0) {
    return Effect.gen(function* () {
      const out: BatchStmtResult[] = [];
      for (const s of stmts) {
        const stmt = yield* stmtOf(driver, s.sql);
        if (stmt.columnNames && stmt.columnNames.length > 0) {
          const rows = yield* Effect.tryPromise({
            try: () => stmt.all(...s.params),
            catch: mapDbError,
          });
          out.push({ results: rows, changes: rows.length });
        } else {
          const changes = yield* Effect.tryPromise({
            try: () => stmt.run(...s.params).then((r) => r.changes),
            catch: mapDbError,
          });
          out.push({ results: [], changes });
        }
      }
      return out;
    });
  }
  return Effect.tryPromise({
    try: () => driver.batch(stmts),
    catch: mapDbError,
  });
}

/** Void-compatible batch — the existing ~50 callers keep their signature. */
export function batch(
  driver: DbDriver,
  stmts: BatchStmt[]
): Effect.Effect<void, ConstraintViolation | DbError> {
  return batchResults(driver, stmts).pipe(Effect.asVoid);
}

// Interactive transaction. Bun-only: on D1 (`supportsInteractiveTx === false`)
// this is a documented no-op — the body runs SEQUENTIALLY with no BEGIN/
// ROLLBACK, so a mid-body failure leaves prior writes committed. Every
// multi-write site MUST therefore use one `batch()`/`batchResults()` call;
// `withTx` remains only as Bun isolation for sites not yet converted.
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

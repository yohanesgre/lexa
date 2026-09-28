import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import { backfillProviderSecrets, type BackfillReport } from "./provider-secrets-backfill";
import type { RuntimeEnv } from "../env";

/**
 * Bun-boot wiring for the one-way provider-key backfill: open the DB on its own
 * short-lived connection, run the effect to completion (it suspends on
 * WebCrypto promises, so `Effect.runSync` would throw AsyncFiberException), and
 * always close. Exported so the exact boot path is executable-tested.
 */
export async function runBootBackfill(dbPath: string, env: RuntimeEnv): Promise<BackfillReport> {
  const db = new Database(dbPath);
  try {
    return await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), env));
  } finally {
    db.close();
  }
}

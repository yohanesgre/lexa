import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import { syncGitHubConfigFromDbAsync } from "../github/client";
import type { RuntimeEnv } from "../env";

/**
 * Bun-boot wiring for the encrypted-aware GitHub config apply. Opens the DB on
 * its own short-lived connection, runs the effect to completion (it suspends on
 * WebCrypto promises — decrypting github_app_secrets — so `Effect.runSync`
 * would throw AsyncFiberException), and always closes. Mirrors
 * provider-secrets-boot.ts; exported so the boot path is executable-tested.
 */
export async function runGithubConfigBoot(dbPath: string, env: RuntimeEnv): Promise<void> {
  const db = new Database(dbPath);
  try {
    await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db), env));
  } finally {
    db.close();
  }
}

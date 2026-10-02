import { describe, it, expect } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { GitHubConfig, GitHubConfigLive, syncGitHubConfigFromDbAsync } from "./client";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";

// Reads the live config holder through the tag — proves GitHubConfigLive serves
// the mutable holder, so every consumer (client service, webhook verifier)
// sees Settings saves without a runtime rebuild.
async function liveConfig(): Promise<GitHubConfig["Type"]> {
  const runtime = ManagedRuntime.make(GitHubConfigLive);
  try {
    return await runtime.runPromise(Effect.gen(function* () {
      return yield* GitHubConfig;
    }));
  } finally {
    await runtime.dispose();
  }
}

describe("syncGitHubConfigFromDbAsync", () => {
  const freshDb = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    return db;
  };

  const sync = (db: Database) => Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));

  it("applies settings rows to the live config holder", async () => {
    const db = freshDb();
    setSetting(db, "github_app_id", "12345");
    setSetting(db, "github_private_key", PEM);
    setSetting(db, "github_webhook_secret", "whsec");
    await sync(db);
    const cfg = await liveConfig();
    expect(cfg).toEqual({ appId: "12345", privateKey: PEM, webhookSecret: "whsec" });
    db.close();
  });

  it("missing settings rows are a no-op (not configured, no throw)", async () => {
    const db = freshDb();
    await expect(sync(db)).resolves.toBeUndefined();
    expect(await liveConfig()).toEqual({ appId: "", privateKey: "", webhookSecret: "" });
    db.close();
  });

  it("ignores GITHUB_* env vars — config is DB/web-only", async () => {
    const prevAppId = process.env.GITHUB_APP_ID;
    const prevPrivateKey = process.env.GITHUB_PRIVATE_KEY;
    process.env.GITHUB_APP_ID = "99999";
    process.env.GITHUB_PRIVATE_KEY = PEM;
    try {
      const db = freshDb();
      await sync(db);
      expect(await liveConfig()).toEqual({ appId: "", privateKey: "", webhookSecret: "" });
      db.close();
    } finally {
      if (prevAppId === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = prevAppId;
      if (prevPrivateKey === undefined) delete process.env.GITHUB_PRIVATE_KEY;
      else process.env.GITHUB_PRIVATE_KEY = prevPrivateKey;
    }
  });
});

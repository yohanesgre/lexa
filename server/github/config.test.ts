import { describe, it, expect } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { GitHubConfig, GitHubConfigLive, syncGitHubConfigFromDb } from "./client";

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

describe("syncGitHubConfigFromDb", () => {
  const freshDb = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    return db;
  };

  it("applies settings rows to the live config holder", async () => {
    const db = freshDb();
    setSetting(db, "github_app_id", "12345");
    setSetting(db, "github_private_key", PEM);
    setSetting(db, "github_webhook_secret", "whsec");
    syncGitHubConfigFromDb(db);
    const cfg = await liveConfig();
    expect(cfg).toEqual({ appId: "12345", privateKey: PEM, webhookSecret: "whsec" });
    db.close();
  });

  it("DB wins even when env vars differ (env is bootstrap-only, ignored at runtime)", async () => {
    const saved = {
      appId: process.env.GITHUB_APP_ID,
      key: process.env.GITHUB_PRIVATE_KEY,
      file: process.env.GITHUB_PRIVATE_KEY_FILE,
      secret: process.env.GITHUB_WEBHOOK_SECRET,
    };
    process.env.GITHUB_APP_ID = "999";
    process.env.GITHUB_PRIVATE_KEY = "env-pem";
    process.env.GITHUB_WEBHOOK_SECRET = "env-secret";
    try {
      const db = freshDb();
      setSetting(db, "github_app_id", "111");
      setSetting(db, "github_private_key", PEM);
      setSetting(db, "github_webhook_secret", "db-secret");
      syncGitHubConfigFromDb(db);
      const cfg = await liveConfig();
      expect(cfg).toEqual({ appId: "111", privateKey: PEM, webhookSecret: "db-secret" });
      db.close();
    } finally {
      if (saved.appId !== undefined) process.env.GITHUB_APP_ID = saved.appId; else delete process.env.GITHUB_APP_ID;
      if (saved.key !== undefined) process.env.GITHUB_PRIVATE_KEY = saved.key; else delete process.env.GITHUB_PRIVATE_KEY;
      if (saved.file !== undefined) process.env.GITHUB_PRIVATE_KEY_FILE = saved.file; else delete process.env.GITHUB_PRIVATE_KEY_FILE;
      if (saved.secret !== undefined) process.env.GITHUB_WEBHOOK_SECRET = saved.secret; else delete process.env.GITHUB_WEBHOOK_SECRET;
    }
  });

  it("env vars are ignored when the DB is empty → not configured", async () => {
    const saved = {
      appId: process.env.GITHUB_APP_ID,
      key: process.env.GITHUB_PRIVATE_KEY,
      file: process.env.GITHUB_PRIVATE_KEY_FILE,
      secret: process.env.GITHUB_WEBHOOK_SECRET,
    };
    process.env.GITHUB_APP_ID = "999";
    process.env.GITHUB_PRIVATE_KEY = "env-pem";
    process.env.GITHUB_PRIVATE_KEY_FILE = "/some/file.pem";
    process.env.GITHUB_WEBHOOK_SECRET = "env-secret";
    try {
      const db = freshDb();
      syncGitHubConfigFromDb(db); // no settings rows
      const cfg = await liveConfig();
      expect(cfg).toEqual({ appId: "", privateKey: "", webhookSecret: "" });
      db.close();
    } finally {
      if (saved.appId !== undefined) process.env.GITHUB_APP_ID = saved.appId; else delete process.env.GITHUB_APP_ID;
      if (saved.key !== undefined) process.env.GITHUB_PRIVATE_KEY = saved.key; else delete process.env.GITHUB_PRIVATE_KEY;
      if (saved.file !== undefined) process.env.GITHUB_PRIVATE_KEY_FILE = saved.file; else delete process.env.GITHUB_PRIVATE_KEY_FILE;
      if (saved.secret !== undefined) process.env.GITHUB_WEBHOOK_SECRET = saved.secret; else delete process.env.GITHUB_WEBHOOK_SECRET;
    }
  });

  it("missing settings rows are a no-op (not configured, no throw)", async () => {
    const db = freshDb();
    expect(() => syncGitHubConfigFromDb(db)).not.toThrow();
    expect(await liveConfig()).toEqual({ appId: "", privateKey: "", webhookSecret: "" });
    db.close();
  });
});

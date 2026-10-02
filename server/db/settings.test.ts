import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { getSetting, mirrorSettingsFromEnv, setSetting } from "./settings";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";

const freshDb = () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  return db;
};

describe("mirrorSettingsFromEnv", () => {
  it("mirrors rate-limit and cap env values into empty settings rows", () => {
    const db = freshDb();
    const mirrored = mirrorSettingsFromEnv(db, {
      LXK_RATE_LIMIT_MAX: "100",
      LXK_RATE_LIMIT_WINDOW_MS: "5000",
      LXK_ASSISTANT_REPO_CAP: "7",
    });
    expect(mirrored).toEqual(["rate_limit_max", "rate_limit_window_ms", "assistant_repo_cap"]);
    expect(getSetting(db, "rate_limit_max")).toBe("100");
    expect(getSetting(db, "rate_limit_window_ms")).toBe("5000");
    expect(getSetting(db, "assistant_repo_cap")).toBe("7");
    db.close();
  });

  it("never overwrites existing DB values", () => {
    const db = freshDb();
    setSetting(db, "rate_limit_max", "10");
    const mirrored = mirrorSettingsFromEnv(db, {
      LXK_RATE_LIMIT_MAX: "999",
      LXK_RATE_LIMIT_WINDOW_MS: "5000",
    });
    expect(mirrored).toEqual(["rate_limit_window_ms"]); // only the absent key mirrored
    expect(getSetting(db, "rate_limit_max")).toBe("10");
    expect(getSetting(db, "rate_limit_window_ms")).toBe("5000");
    db.close();
  });

  it("empty-string DB values count as absent (re-import on next boot)", () => {
    const db = freshDb();
    setSetting(db, "rate_limit_max", "");
    const mirrored = mirrorSettingsFromEnv(db, { LXK_RATE_LIMIT_MAX: "333" });
    expect(mirrored).toEqual(["rate_limit_max"]);
    expect(getSetting(db, "rate_limit_max")).toBe("333");
    db.close();
  });

  it("ignores legacy GitHub env vars — no github_% rows", () => {
    const db = freshDb();
    const mirrored = mirrorSettingsFromEnv(db, {
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: PEM,
      GITHUB_PRIVATE_KEY_FILE: "/x.pem",
      GITHUB_WEBHOOK_SECRET: "whsec",
      LXK_RATE_LIMIT_MAX: "100",
    });
    expect(mirrored).toEqual(["rate_limit_max"]);
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'github_%'").get()).toEqual({ c: 0 });
    db.close();
  });

  it("empty env returns an empty mirrored list", () => {
    const db = freshDb();
    expect(mirrorSettingsFromEnv(db, {})).toEqual([]);
    db.close();
  });
});

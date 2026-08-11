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
  it("mirrors env values into empty settings rows", () => {
    const db = freshDb();
    const mirrored = mirrorSettingsFromEnv(db, {
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: PEM,
      GITHUB_WEBHOOK_SECRET: "whsec",
      LXK_RATE_LIMIT_MAX: "100",
      LXK_RATE_LIMIT_WINDOW_MS: "5000",
    });
    expect(mirrored).toEqual(["github_app_id", "github_webhook_secret", "github_private_key", "rate_limit_max", "rate_limit_window_ms"]);
    expect(getSetting(db, "github_app_id")).toBe("12345");
    expect(getSetting(db, "github_private_key")).toBe(PEM);
    expect(getSetting(db, "github_webhook_secret")).toBe("whsec");
    expect(getSetting(db, "rate_limit_max")).toBe("100");
    expect(getSetting(db, "rate_limit_window_ms")).toBe("5000");
    db.close();
  });

  it("never overwrites existing DB values", () => {
    const db = freshDb();
    setSetting(db, "github_app_id", "111");
    setSetting(db, "rate_limit_max", "10");
    const mirrored = mirrorSettingsFromEnv(db, {
      GITHUB_APP_ID: "222",
      GITHUB_PRIVATE_KEY: PEM,
      LXK_RATE_LIMIT_MAX: "999",
    });
    expect(mirrored).toEqual(["github_private_key"]); // only the absent key mirrored
    expect(getSetting(db, "github_app_id")).toBe("111");
    expect(getSetting(db, "rate_limit_max")).toBe("10");
    expect(getSetting(db, "github_private_key")).toBe(PEM);
    db.close();
  });

  it("empty-string DB values count as absent (re-import on next boot)", () => {
    const db = freshDb();
    setSetting(db, "github_app_id", "");
    const mirrored = mirrorSettingsFromEnv(db, { GITHUB_APP_ID: "333" });
    expect(mirrored).toEqual(["github_app_id"]);
    expect(getSetting(db, "github_app_id")).toBe("333");
    db.close();
  });

  it("reads GITHUB_PRIVATE_KEY_FILE content at mirror time and stores it", () => {
    const db = freshDb();
    const mirrored = mirrorSettingsFromEnv(db, { GITHUB_PRIVATE_KEY_FILE: "/x.pem" }, () => PEM);
    expect(mirrored).toEqual(["github_private_key"]);
    expect(getSetting(db, "github_private_key")).toBe(PEM);
    db.close();
  });

  it("unreadable GITHUB_PRIVATE_KEY_FILE is skipped (warn, no row, no throw)", () => {
    const db = freshDb();
    expect(() =>
      mirrorSettingsFromEnv(db, { GITHUB_PRIVATE_KEY_FILE: "/does/not/exist.pem" }, () => {
        throw new Error("ENOENT");
      })
    ).not.toThrow();
    expect(getSetting(db, "github_private_key")).toBeNull();
    db.close();
  });

  it("inline GITHUB_PRIVATE_KEY wins over the file", () => {
    const db = freshDb();
    const mirrored = mirrorSettingsFromEnv(
      db,
      { GITHUB_PRIVATE_KEY: "inline-pem", GITHUB_PRIVATE_KEY_FILE: "/x.pem" },
      () => "file-pem"
    );
    expect(mirrored).toEqual(["github_private_key"]);
    expect(getSetting(db, "github_private_key")).toBe("inline-pem");
    db.close();
  });

  it("existing github_private_key row skips the file read entirely", () => {
    const db = freshDb();
    setSetting(db, "github_private_key", "existing");
    let readCalled = false;
    mirrorSettingsFromEnv(db, { GITHUB_PRIVATE_KEY_FILE: "/x.pem" }, () => {
      readCalled = true;
      return PEM;
    });
    expect(readCalled).toBe(false);
    expect(getSetting(db, "github_private_key")).toBe("existing");
    db.close();
  });

  it("empty env returns an empty mirrored list", () => {
    const db = freshDb();
    expect(mirrorSettingsFromEnv(db, {})).toEqual([]);
    db.close();
  });
});

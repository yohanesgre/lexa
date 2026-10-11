import { describe, expect, it, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runMigrations } from "./migrate";
import { backfillProviderSecrets } from "./provider-secrets-backfill";
import { runBootBackfill } from "./provider-secrets-boot";
import { backfillTaskKeys } from "./task-keys-backfill";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import { decryptSecret, parseMasterKey } from "../assistant/secrets";
import { getSetting, mirrorSettingsFromEnv, setSetting } from "./settings";
import type { RuntimeEnv } from "../env";

const MASTER_KEY = Buffer.from("p".repeat(32)).toString("base64");
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";

let dirs: string[] = [];

/** Migrated temp DB on the default migrations dir. */
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-db-backfill-"));
  dirs.push(dir);
  const dbPath = join(dir, "app.db");
  runMigrations(dbPath);
  return new Database(dbPath);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const envWith = (raw?: string): RuntimeEnv =>
  (raw === undefined ? {} : { LXK_SECRETS_MASTER_KEY: raw }) as RuntimeEnv;

const providerSecret = (db: Database, id: string) =>
  db
    .prepare("SELECT ciphertext, iv, key_id, key_hint FROM assistant_provider_secrets WHERE provider_id = ?")
    .get(id) as { ciphertext: string; iv: string; key_id: string; key_hint: string } | null;

const apiKey = (db: Database, id: string) =>
  (db.prepare("SELECT api_key FROM assistant_providers WHERE id = ?").get(id) as { api_key: string }).api_key;

describe("backfillProviderSecrets", () => {
  it("encrypts a plaintext key, stores the hint, and clears the legacy column", async () => {
    const db = freshDb();
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-live-abcd')`);
    const report = await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith(MASTER_KEY)));
    expect(report).toEqual({ encrypted: 1, cleared: 1, blocked: 0 });
    expect(apiKey(db, "pr1")).toBe("");

    const row = providerSecret(db, "pr1");
    expect(row).not.toBeNull();
    expect(row!.key_hint).toBe("abcd");
    // The stored blob round-trips through the provider scope.
    const plaintext = await decryptSecret(
      { ciphertextB64: row!.ciphertext, ivB64: row!.iv, keyId: row!.key_id as "active", scope: "provider", ownerId: "pr1" },
      { active: await parseMasterKey(MASTER_KEY) }
    );
    expect(plaintext).toBe("sk-live-abcd");
    db.close();
  });

  it("is idempotent: a second run selects nothing and writes nothing", async () => {
    const db = freshDb();
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-one-1111')`);
    await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith(MASTER_KEY)));
    const first = providerSecret(db, "pr1")!;
    const report = await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith(MASTER_KEY)));
    expect(report).toEqual({ encrypted: 0, cleared: 0, blocked: 0 });
    expect(providerSecret(db, "pr1")!.ciphertext).toBe(first.ciphertext);
    db.close();
  });

  it("without a keyring it reports blocked and writes nothing", async () => {
    const db = freshDb();
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-blocked')`);
    const report = await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith()));
    expect(report).toEqual({ encrypted: 0, cleared: 0, blocked: 1 });
    expect(apiKey(db, "pr1")).toBe("sk-blocked");
    expect(providerSecret(db, "pr1")).toBeNull();
    db.close();
  });

});

describe("backfillTaskKeys", () => {
  function seedLegacy(db: Database) {
    db.exec(`
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot');
      INSERT INTO projects (id, name, slug) VALUES ('p2', 'Web Client', 'web-client');
      INSERT INTO projects (id, name, slug) VALUES ('p3', 'Web Crawler', 'web-crawler');
      INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
      INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t3', 'p2', 'c1', 's1', 'C', 'a2');
    `);
  }

  it("assigns collision-resolved keys and per-project numbers", () => {
    const db = freshDb();
    seedLegacy(db);
    backfillTaskKeys(db);
    const projects = db.query("SELECT slug, key FROM projects ORDER BY created_at").all() as { slug: string; key: string }[];
    expect(projects.map((p) => p.key)).toEqual(["EG", "WC", "WCR"]);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY created_at").all() as { id: string; number: number; key: string }[];
    expect(tasks).toEqual([
      { id: "t1", number: 1, key: "EG-1" },
      { id: "t2", number: 2, key: "EG-2" },
      { id: "t3", number: 1, key: "WC-1" },
    ]);
  });
  it("is idempotent", () => {
    const db = freshDb();
    seedLegacy(db);
    backfillTaskKeys(db);
    backfillTaskKeys(db);
    const n = db.query("SELECT COUNT(*) AS n FROM tasks WHERE key IS NULL").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("resumes from already-assigned numbers without reuse or unique violation", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot', 'EG', 2);
      INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
      INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0', 1, 'EG-1');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1', 5, 'EG-5');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t3', 'p1', 'c1', 's1', 'C', 'a2');
    `);
    backfillTaskKeys(db);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY id").all() as { id: string; number: number; key: string }[];
    expect(tasks).toEqual([
      { id: "t1", number: 1, key: "EG-1" },
      { id: "t2", number: 5, key: "EG-5" },
      { id: "t3", number: 6, key: "EG-6" },
    ]);
    const project = db.query("SELECT next_task_number FROM projects WHERE id = 'p1'").get() as { next_task_number: number };
    expect(project.next_task_number).toBe(6);
  });
});

describe("mirrorSettingsFromEnv", () => {
  const freshSettingsDb = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    return db;
  };

  it("mirrors rate-limit and cap env values into empty settings rows", () => {
    const db = freshSettingsDb();
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
    const db = freshSettingsDb();
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
    const db = freshSettingsDb();
    setSetting(db, "rate_limit_max", "");
    const mirrored = mirrorSettingsFromEnv(db, { LXK_RATE_LIMIT_MAX: "333" });
    expect(mirrored).toEqual(["rate_limit_max"]);
    expect(getSetting(db, "rate_limit_max")).toBe("333");
    db.close();
  });

  it("ignores legacy GitHub env vars — no github_% rows", () => {
    const db = freshSettingsDb();
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
    const db = freshSettingsDb();
    expect(mirrorSettingsFromEnv(db, {})).toEqual([]);
    db.close();
  });
});

describe("runBootBackfill (Bun boot wiring)", () => {
  it("resolves on a migrated DB without throwing (AsyncFiberException regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-db-backfill-boot-"));
    dirs.push(dir);
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath);
    await expect(runBootBackfill(dbPath, envWith(MASTER_KEY))).resolves.toEqual({ encrypted: 0, cleared: 0, blocked: 0 });
  });
});

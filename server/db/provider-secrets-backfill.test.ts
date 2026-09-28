import { describe, expect, it, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runMigrations } from "./migrate";
import { backfillProviderSecrets } from "./provider-secrets-backfill";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import { decryptSecret, parseMasterKey } from "../assistant/secrets";
import type { RuntimeEnv } from "../env";

const MASTER_KEY = Buffer.from("p".repeat(32)).toString("base64");

let dirs: string[] = [];

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-provider-secret-backfill-"));
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

  it("a malformed keyring is blocked too (nothing is destroyed)", async () => {
    const db = freshDb();
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-blocked')`);
    const report = await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith("not-base64")));
    expect(report).toEqual({ encrypted: 0, cleared: 0, blocked: 1 });
    expect(apiKey(db, "pr1")).toBe("sk-blocked");
    db.close();
  });

  it("a pre-existing secret row is only cleared, never re-encrypted", async () => {
    const db = freshDb();
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-cloud-copy')`);
    db.exec(`INSERT INTO assistant_provider_secrets (provider_id, ciphertext, iv, key_id, key_hint) VALUES ('pr1', 'existing', 'iv', 'active', '9999')`);
    const report = await Effect.runPromise(backfillProviderSecrets(createBunSqliteDriver(db), envWith(MASTER_KEY)));
    expect(report).toEqual({ encrypted: 0, cleared: 1, blocked: 0 });
    expect(apiKey(db, "pr1")).toBe("");
    const row = providerSecret(db, "pr1")!;
    expect(row.ciphertext).toBe("existing");
    expect(row.key_hint).toBe("9999");
    db.close();
  });
});

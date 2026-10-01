import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { encryptSecret, secretsKeyringFromEnv, type EncryptedSecret } from "../assistant/secrets";
import {
  deleteGithubSecret,
  githubSettingsSummary,
  resolveGithubAppSecrets,
  storeGithubAppCredentials,
} from "./config-store";
import type { RuntimeEnv } from "../env";

const KEY_A = Buffer.from("a".repeat(32)).toString("base64");
const KEY_B = Buffer.from("b".repeat(32)).toString("base64");
const ENV_A = { LXK_SECRETS_MASTER_KEY: KEY_A } as RuntimeEnv;

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nsecret-body\n-----END RSA PRIVATE KEY-----";

// Effect failures reject `runPromise` wrapped in a FiberFailure, so the tag is
// only observable through `Either`.
async function leftTag<A, E extends { _tag: string }>(effect: Effect.Effect<A, E, never>): Promise<string | undefined> {
  const either = await Effect.runPromise(Effect.either(effect));
  return either._tag === "Left" ? either.left._tag : undefined;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE github_app_secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  return db;
}

describe("github config store", () => {
  let db: Database;
  let driver: ReturnType<typeof createBunSqliteDriver>;

  beforeEach(() => {
    db = freshDb();
    driver = createBunSqliteDriver(db);
  });
  afterEach(() => db.close());

  const store = (env: RuntimeEnv, input?: Partial<{ appId: string; slug: string }>) =>
    Effect.runPromise(
      storeGithubAppCredentials(driver, env, {
        appId: input?.appId ?? "4242",
        slug: input?.slug ?? "lexa-test",
        privateKey: PEM,
        webhookSecret: "whsec-1",
      })
    );

  const resolve = (env: RuntimeEnv = ENV_A) => Effect.runPromise(resolveGithubAppSecrets(driver, env));
  const summary = () => Effect.runPromise(githubSettingsSummary(driver));

  it("stores credentials encrypted, clears legacy plaintext, and records app id + slug", async () => {
    await store(ENV_A);

    const rows = db.prepare("SELECT name FROM github_app_secrets ORDER BY name").all() as { name: string }[];
    expect(rows).toEqual([{ name: "private_key" }, { name: "webhook_secret" }]);
    // No plaintext copy survives anywhere in settings.
    const plaintext = db.prepare("SELECT key FROM settings WHERE key IN ('github_private_key','github_webhook_secret')").all();
    expect(plaintext).toEqual([]);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_id'").get()).toEqual({ value: "4242" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_slug'").get()).toEqual({ value: "lexa-test" });

    await expect(resolve()).resolves.toEqual({ privateKey: PEM, webhookSecret: "whsec-1" });
    expect(await summary()).toEqual({
      appId: "4242",
      appSlug: "lexa-test",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
  });

  it("storeGithubAppCredentials deletes a pre-existing legacy plaintext row", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', 'legacy-pem')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_webhook_secret', 'legacy-secret')").run();

    await store(ENV_A);

    expect(
      db.prepare("SELECT key FROM settings WHERE key IN ('github_private_key','github_webhook_secret')").all()
    ).toEqual([]);
    await expect(resolve()).resolves.toEqual({ privateKey: PEM, webhookSecret: "whsec-1" });
  });

  it("a blank slug clears the stored slug (app id + secrets stay)", async () => {
    await store(ENV_A, { slug: "legacy-slug" });
    await store(ENV_A, { slug: "" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_slug'").get()).toBeNull();
    expect(await summary()).toMatchObject({ appId: "4242", appSlug: "", privateKeySet: true, source: "settings" });
  });

  it("without a master key the encrypted write is refused (GithubSecretWriteFailed)", async () => {
    expect(
      await leftTag(
        storeGithubAppCredentials(driver, {} as RuntimeEnv, {
          appId: "4242",
          slug: "lexa-test",
          privateKey: PEM,
          webhookSecret: "whsec-1",
        })
      )
    ).toBe("GithubSecretWriteFailed");
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'github_%'").get()).toEqual({ c: 0 });
  });

  it("legacy plaintext settings rows still resolve (env/plaintext installs keep working)", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_app_id', '111')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', ?)").run(PEM);
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_webhook_secret', 'old-secret')").run();

    await expect(resolve({} as RuntimeEnv)).resolves.toEqual({ privateKey: PEM, webhookSecret: "old-secret" });
    expect(await summary()).toEqual({
      appId: "111",
      appSlug: "",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
  });

  it("an encrypted row is authoritative — unopenable reads as unset, never as plaintext fallback", async () => {
    // Legit plaintext install …
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', ?)").run(PEM);
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_webhook_secret', 'old-secret')").run();
    // … then an encrypted row sealed under a DIFFERENT master key.
    const keyringA = await secretsKeyringFromEnv(ENV_A);
    expect(keyringA).not.toBeNull();
    const sealed: EncryptedSecret = await encryptSecret(PEM, "github", "private_key", keyringA!.active, keyringA!);
    db.prepare("INSERT INTO github_app_secrets (name, ciphertext, iv, key_id) VALUES ('private_key', ?, ?, ?)").run(
      sealed.ciphertextB64,
      sealed.ivB64,
      sealed.keyId
    );

    // With the wrong keyring (KEY_B) the encrypted row cannot open → "" — the
    // stale plaintext row must NOT shadow it. The webhook secret has no
    // encrypted row, so its plaintext fallback still works.
    const wrong = { LXK_SECRETS_MASTER_KEY: KEY_B } as RuntimeEnv;
    await expect(resolve(wrong)).resolves.toEqual({ privateKey: "", webhookSecret: "old-secret" });

    // With no keyring at all the presence is still a hard "unset".
    await expect(resolve({} as RuntimeEnv)).resolves.toEqual({ privateKey: "", webhookSecret: "old-secret" });
  });

  it("summary counts an encrypted presence as set; a slug alone never flips source", async () => {
    const keyring = await secretsKeyringFromEnv(ENV_A);
    const sealed: EncryptedSecret = await encryptSecret(PEM, "github", "private_key", keyring!.active, keyring!);
    db.prepare("INSERT INTO github_app_secrets (name, ciphertext, iv, key_id) VALUES ('private_key', ?, ?, ?)").run(
      sealed.ciphertextB64,
      sealed.ivB64,
      sealed.keyId
    );
    expect(await summary()).toMatchObject({ privateKeySet: true, webhookSecretSet: false, source: "settings" });

    db.exec("DELETE FROM github_app_secrets");
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_app_slug', 'only-slug')").run();
    expect(await summary()).toEqual({
      appId: "",
      appSlug: "only-slug",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });
  });

  it("deleteGithubSecret removes the encrypted row (manual PUT clear path)", async () => {
    await store(ENV_A);
    await Effect.runPromise(deleteGithubSecret(driver, "private_key"));
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets WHERE name = 'private_key'").get()).toEqual({ c: 0 });
    await expect(resolve()).resolves.toEqual({ privateKey: "", webhookSecret: "whsec-1" });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import type { DbDriver } from "../db/driver";
import { encryptSecret, secretsKeyringFromEnv, type EncryptedSecret } from "../assistant/secrets";
import {
  deleteGithubSecret,
  githubSettingsSummary,
  resolveGithubAppSecrets,
  storeGithubAppCredentials,
} from "./config-store";
import {
  MANIFEST_STATE_SETTING_KEY,
  REQUIRED_MANIFEST_PERMISSIONS,
  assertRequiredPermissions,
  buildManifest,
  consumeManifestState,
  createManifestState,
  exchangeManifestCode,
} from "./manifest";
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
  let driver: DbDriver;

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

  it("deleteGithubSecret removes the encrypted row (manual PUT clear path)", async () => {
    await store(ENV_A);
    await Effect.runPromise(deleteGithubSecret(driver, "private_key"));
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets WHERE name = 'private_key'").get()).toEqual({ c: 0 });
    await expect(resolve()).resolves.toEqual({ privateKey: "", webhookSecret: "whsec-1" });
  });

  it("storeGithubAppCredentials is all-or-nothing: a mid-batch failure rolls back every write", async () => {
    // Force the private_key upsert (statement 3 of 6) to abort. ABORT raises to
    // the JS run(), so the Bun driver's transaction rolls the whole array back.
    db.exec(`CREATE TRIGGER fail_private_key BEFORE INSERT ON github_app_secrets
             WHEN NEW.name = 'private_key' BEGIN SELECT RAISE(ABORT, 'forced-failure'); END;`);
    // A legacy plaintext row the batch would clear on success — it must survive.
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', 'legacy-pem')").run();

    expect(await leftTag(storeGithubAppCredentials(driver, ENV_A, {
      appId: "4242",
      slug: "lexa-test",
      privateKey: PEM,
      webhookSecret: "whsec-1",
    }))).toBe("GithubSecretWriteFailed");

    // Nothing from the failed batch survived: no app id/slug, no secrets, and
    // the legacy plaintext row was not cleared.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_id'").get()).toBeNull();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_slug'").get()).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: "legacy-pem" });
    db.exec("DROP TRIGGER fail_private_key");
  });
});

// ── manifest flow (absorbed from manifest.test.ts) ─────────────────────────
describe("buildManifest", () => {
  it("points every URL at the public base and asks for exactly the required scopes", () => {
    const manifest = buildManifest("https://lexa.example.com/");
    expect(manifest).toEqual({
      name: "Lexa",
      url: "https://lexa.example.com",
      hook_attributes: { url: "https://lexa.example.com/api/webhooks/github", active: true },
      redirect_url: "https://lexa.example.com/settings/github/callback",
      public: false,
      default_permissions: { ...REQUIRED_MANIFEST_PERMISSIONS },
      default_events: ["issues"],
    });
  });
});

describe("manifest state — single-use, expiry, mismatch (one error)", () => {
  let db: Database;
  let driver: DbDriver;

  beforeEach(() => {
    db = freshDb();
    driver = createBunSqliteDriver(db);
  });
  afterEach(() => db.close());

  const create = () => Effect.runPromise(createManifestState(driver));
  const consume = (state: string) => Effect.runPromise(consumeManifestState(driver, state));
  const consumeTag = (state: string) => leftTag(consumeManifestState(driver, state));

  it("accepts the issued state exactly once", async () => {
    const state = await create();
    await expect(consume(state)).resolves.toBeUndefined();
    // Second use fails — the row is consumed on the first attempt.
    expect(await consumeTag(state)).toBe("GithubManifestStateInvalid");
  });

  it("rejects a mismatched state (and still consumes it)", async () => {
    const state = await create();
    expect(await consumeTag(`${state}deadbeef`)).toBe("GithubManifestStateInvalid");
    // The mismatch burned the only chance.
    expect(await consumeTag(state)).toBe("GithubManifestStateInvalid");
  });

  it("rejects an expired state", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      MANIFEST_STATE_SETTING_KEY,
      JSON.stringify({ value: "expired-state", expiresMs: Date.now() - 1_000 })
    );
    expect(await consumeTag("expired-state")).toBe("GithubManifestStateInvalid");
  });
});

describe("assertRequiredPermissions", () => {
  it("refuses a report missing a required scope or at the wrong level", async () => {
    expect(await leftTag(assertRequiredPermissions({ issues: "read", metadata: "read", contents: "read" }))).toBe(
      "GithubManifestPermissionsDenied"
    );
    expect(await leftTag(assertRequiredPermissions({ issues: "write", metadata: "read" }))).toBe(
      "GithubManifestPermissionsDenied"
    );
  });
});

describe("exchangeManifestCode", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  it("maps GitHub's conversion payload to credentials", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: 4242,
        slug: "lexa-test",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "whsec-1",
        permissions: { issues: "write", metadata: "read", contents: "read" },
      })
    );
    const creds = await Effect.runPromise(exchangeManifestCode("the-code"));
    expect(creds).toEqual({
      appId: "4242",
      slug: "lexa-test",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
      webhookSecret: "whsec-1",
      permissions: { issues: "write", metadata: "read", contents: "read" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/the-code/conversions",
      expect.objectContaining({ method: "POST" })
    );
  });
});


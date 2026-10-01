// GitHub App credential store — the encrypted half of the runtime config.
//
// The settings table stays the source of truth for `github_app_id` (not a
// secret) and `github_app_slug` (public identifier). The private key and
// webhook secret live ENCRYPTED in `github_app_secrets` (scope "github",
// AAD-bound to the row name) whenever they were written by the manifest
// connect flow. Legacy plaintext `settings.github_private_key` /
// `github_webhook_secret` rows stay READABLE as a fallback for existing
// installs (no migration in this plan). Resolution order is explicit:
//
//   1. an encrypted row, when present, is authoritative — if it exists but
//      cannot be opened, the value reads as "" (a hard refusal, never a silent
//      fall back to a stale plaintext row);
//   2. otherwise the legacy plaintext settings row.
//
// A manual Settings PUT is the opposite: it writes plaintext and deletes the
// encrypted row, so the last explicit write always wins.

import { Effect } from "effect";
import { queryAll, run, withTx, ConstraintViolation, DbError, type DbDriver } from "../db/db";
import { encryptSecret, decryptSecret, secretsKeyringFromEnv, type EncryptedSecret, type SecretKeyId, type SecretKeyring } from "../assistant/secrets";
import { GithubSecretWriteFailed } from "../api/errors";
import type { RuntimeEnv } from "../env";

export type GithubSecretName = "private_key" | "webhook_secret";

export interface GithubAppSecrets {
  privateKey: string;
  webhookSecret: string;
}

export interface GithubSettingsSummary {
  appId: string;
  appSlug: string;
  privateKeySet: boolean;
  webhookSecretSet: boolean;
  source: "settings" | "none";
}

interface SecretRowShape {
  ciphertext: string;
  iv: string;
  key_id: string;
}

const nonEmpty = (v: string | null | undefined): string => (v !== null && v !== undefined && v.trim() !== "" ? v : "");

const readSetting = (driver: DbDriver, key: string): Effect.Effect<string | null, never> =>
  queryAll<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", key).pipe(
    Effect.map((rows) => rows[0]?.value ?? null),
    Effect.catchAll(() => Effect.succeed(null))
  );

const writeSetting = (driver: DbDriver, key: string, value: string): Effect.Effect<void, ConstraintViolation | DbError> =>
  run(
    driver,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    key,
    value
  ).pipe(Effect.asVoid);

const clearSetting = (driver: DbDriver, key: string): Effect.Effect<void, ConstraintViolation | DbError> =>
  run(driver, "DELETE FROM settings WHERE key = ?", key).pipe(Effect.asVoid);

// Missing table (an older test DB that never ran 0017) reads as "no row",
// never an error — the fallback settings rows still work.
const readSecretRow = (driver: DbDriver, name: GithubSecretName): Effect.Effect<SecretRowShape | null, never> =>
  queryAll<SecretRowShape>(driver, "SELECT ciphertext, iv, key_id FROM github_app_secrets WHERE name = ?", name).pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.catchAll(() => Effect.succeed(null))
  );

function keyringOrNull(env: Pick<RuntimeEnv, "LXK_SECRETS_MASTER_KEY" | "LXK_SECRETS_MASTER_KEY_PREV"> | null | undefined): Effect.Effect<SecretKeyring | null, never> {
  return Effect.tryPromise({
    try: () => secretsKeyringFromEnv(env),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
}

// Opens one encrypted row. A present-but-unopenable row resolves to null (and
// is logged) — the caller treats that as "no value", never as an absent row.
function openSecretRow(name: GithubSecretName, row: SecretRowShape, keyring: SecretKeyring): Effect.Effect<string | null, never> {
  return Effect.tryPromise({
    try: () =>
      decryptSecret(
        { ciphertextB64: row.ciphertext, ivB64: row.iv, keyId: row.key_id as SecretKeyId, scope: "github", ownerId: name },
        keyring
      ),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
}

// Effective private key + webhook secret for the GitHub client. Encrypted rows
// first; legacy plaintext rows only when no encrypted row exists.
export function resolveGithubAppSecrets(
  driver: DbDriver,
  env?: Pick<RuntimeEnv, "LXK_SECRETS_MASTER_KEY" | "LXK_SECRETS_MASTER_KEY_PREV"> | null
): Effect.Effect<GithubAppSecrets, never> {
  return Effect.gen(function* () {
    const keyring = yield* keyringOrNull(env);
    const encryptedPrivateKey = yield* resolveOne(driver, keyring, "private_key", "github_private_key");
    const encryptedWebhookSecret = yield* resolveOne(driver, keyring, "webhook_secret", "github_webhook_secret");
    return { privateKey: encryptedPrivateKey, webhookSecret: encryptedWebhookSecret };
  });
}

function resolveOne(
  driver: DbDriver,
  keyring: SecretKeyring | null,
  name: GithubSecretName,
  legacyKey: string
): Effect.Effect<string, never> {
  return Effect.gen(function* () {
    const row = yield* readSecretRow(driver, name);
    if (row !== null) {
      if (keyring === null) {
        console.warn(`[GitHub] encrypted ${name} present but LXK_SECRETS_MASTER_KEY is unset — GitHub config reads as unset`);
        return "";
      }
      const opened = yield* openSecretRow(name, row, keyring);
      if (opened === null) {
        console.warn(`[GitHub] encrypted ${name} could not be decrypted with the configured master key`);
        return "";
      }
      return opened;
    }
    return nonEmpty(yield* readSetting(driver, legacyKey));
  });
}

// Connect-flow write: app id + slug plaintext, both secrets encrypted, legacy
// plaintext rows deleted. Refuses (GithubSecretWriteFailed) when no keyring is
// configured or any write fails — the new path never falls back to plaintext.
export function storeGithubAppCredentials(
  driver: DbDriver,
  env: Pick<RuntimeEnv, "LXK_SECRETS_MASTER_KEY" | "LXK_SECRETS_MASTER_KEY_PREV"> | null | undefined,
  input: { appId: string; slug: string; privateKey: string; webhookSecret: string }
): Effect.Effect<void, GithubSecretWriteFailed> {
  return Effect.gen(function* () {
    const keyring = yield* keyringOrNull(env);
    if (keyring === null) {
      return yield* Effect.fail(new GithubSecretWriteFailed({ message: "secrets master key is not configured" }));
    }
    const sealedPrivate = yield* seal(input.privateKey, "private_key", keyring);
    const sealedWebhook = yield* seal(input.webhookSecret, "webhook_secret", keyring);

    yield* withTx(
      driver,
      Effect.gen(function* () {
        yield* writeSetting(driver, "github_app_id", input.appId);
        if (nonEmpty(input.slug) !== "") yield* writeSetting(driver, "github_app_slug", input.slug);
        else yield* clearSetting(driver, "github_app_slug");
        yield* upsertSecret(driver, "private_key", sealedPrivate);
        yield* upsertSecret(driver, "webhook_secret", sealedWebhook);
        // The encrypted rows are authoritative now; a legacy plaintext row
        // must never be able to shadow them.
        yield* clearSetting(driver, "github_private_key");
        yield* clearSetting(driver, "github_webhook_secret");
      })
    ).pipe(
      Effect.catchAll((e) =>
        Effect.fail(new GithubSecretWriteFailed({ message: e instanceof Error ? e.message : String(e) }))
      )
    );
  });
}

function seal(plaintext: string, name: GithubSecretName, keyring: SecretKeyring): Effect.Effect<EncryptedSecret, GithubSecretWriteFailed> {
  return Effect.tryPromise({
    try: () => encryptSecret(plaintext, "github", name, keyring.active, keyring),
    catch: (e) => new GithubSecretWriteFailed({ message: e instanceof Error ? e.message : String(e) }),
  });
}

function upsertSecret(
  driver: DbDriver,
  name: GithubSecretName,
  sealed: EncryptedSecret
): Effect.Effect<void, ConstraintViolation | DbError> {
  return run(
    driver,
    `INSERT INTO github_app_secrets (name, ciphertext, iv, key_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
       updated_at = datetime('now')`,
    name,
    sealed.ciphertextB64,
    sealed.ivB64,
    sealed.keyId
  ).pipe(Effect.asVoid);
}

// Used by the manual PUT path to clear a credential from BOTH stores. Missing
// table (older DB) is not an error — there is nothing to clear.
export function deleteGithubSecret(driver: DbDriver, name: GithubSecretName): Effect.Effect<void, DbError> {
  return run(driver, "DELETE FROM github_app_secrets WHERE name = ?", name).pipe(
    Effect.asVoid,
    Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e)),
    Effect.catchTag("DbError", () => Effect.void)
  );
}

// Read-only summary for GET/PUT /api/settings/github. Encrypted presence counts
// as "set"; slug never flips `source` on its own.
export function githubSettingsSummary(driver: DbDriver): Effect.Effect<GithubSettingsSummary, never> {
  return Effect.gen(function* () {
    const appId = yield* readSetting(driver, "github_app_id");
    const appSlug = yield* readSetting(driver, "github_app_slug");
    const plainPrivateKey = yield* readSetting(driver, "github_private_key");
    const plainWebhookSecret = yield* readSetting(driver, "github_webhook_secret");
    const encrypted = yield* queryAll<{ name: string }>(driver, "SELECT name FROM github_app_secrets").pipe(
      Effect.catchAll(() => Effect.succeed([] as { name: string }[]))
    );
    const encryptedNames = new Set(encrypted.map((r) => r.name));
    const privateKeySet = nonEmpty(plainPrivateKey) !== "" || encryptedNames.has("private_key");
    const webhookSecretSet = nonEmpty(plainWebhookSecret) !== "" || encryptedNames.has("webhook_secret");
    const configured = nonEmpty(appId) !== "" || privateKeySet || webhookSecretSet;
    return {
      appId: nonEmpty(appId),
      appSlug: nonEmpty(appSlug),
      privateKeySet,
      webhookSecretSet,
      source: configured ? "settings" : "none",
    };
  });
}

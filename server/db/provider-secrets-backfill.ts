import { Effect } from "effect";
import { queryAll, run, withTx, DbError } from "./db";
import type { DbDriver } from "./db";
import type { RuntimeEnv } from "../env";
import { encryptSecret, secretsKeyringFromEnv, type SecretKeyring } from "../assistant/secrets";

export interface BackfillReport {
  encrypted: number;
  cleared: number;
  blocked: number;
}

const BLOCKED_LOG = (n: number) =>
  `[Secrets] ${n} provider key(s) are plaintext and LXK_SECRETS_MASTER_KEY is unset — provider calls will fail until it is set and the server restarts`;

/**
 * Encrypts every non-empty assistant_providers.api_key into
 * assistant_provider_secrets (scope "provider", ownerId = provider id), stores
 * key_hint = last 4 chars, then writes api_key = ''. Idempotent: a cleared row
 * is no longer selected, and a row that already has a secret row is only
 * cleared (its stored ciphertext is never re-encrypted).
 *
 * No keyring → nothing is written and every pending row is reported as blocked.
 */
export function backfillProviderSecrets(driver: DbDriver, env: RuntimeEnv): Effect.Effect<BackfillReport, DbError> {
  return withTx(
    driver,
    Effect.gen(function* () {
      const rows = yield* queryAll<{ id: string; api_key: string }>(
        driver,
        `SELECT id, api_key FROM assistant_providers WHERE api_key IS NOT NULL AND api_key <> ''`
      );
      if (rows.length === 0) return { encrypted: 0, cleared: 0, blocked: 0 };

      // An unset OR malformed key is the blocked case: nothing is written, so a
      // credential is never cleared before a usable replacement is stored.
      const keyring: SecretKeyring | null = yield* Effect.tryPromise({
        try: () => secretsKeyringFromEnv(env),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));

      if (keyring === null) {
        console.error(BLOCKED_LOG(rows.length));
        return { encrypted: 0, cleared: 0, blocked: rows.length };
      }

      let encrypted = 0;
      let cleared = 0;
      for (const row of rows) {
        const existing = yield* queryAll<{ provider_id: string }>(
          driver,
          `SELECT provider_id FROM assistant_provider_secrets WHERE provider_id = ?`,
          row.id
        );
        if (existing.length === 0) {
          const sealed = yield* Effect.tryPromise({
            try: () => encryptSecret(row.api_key, "provider", row.id, keyring.active, keyring),
            catch: (e) => new DbError({ message: `provider key encryption failed: ${String(e)}`, cause: e }),
          });
          yield* run(
            driver,
            `INSERT INTO assistant_provider_secrets (provider_id, ciphertext, iv, key_id, key_hint)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(provider_id) DO UPDATE SET
               ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
               key_hint = excluded.key_hint, updated_at = datetime('now')`,
            row.id,
            sealed.ciphertextB64,
            sealed.ivB64,
            sealed.keyId,
            row.api_key.slice(-4)
          ).pipe(Effect.catchTag("ConstraintViolation", (e) => Effect.fail(new DbError({ message: e.message }))));
          encrypted += 1;
        }
        yield* run(driver, `UPDATE assistant_providers SET api_key = '', updated_at = datetime('now') WHERE id = ?`, row.id).pipe(
          Effect.catchTag("ConstraintViolation", (e) => Effect.fail(new DbError({ message: e.message })))
        );
        cleared += 1;
      }

      if (encrypted > 0) console.log(`[Secrets] backfilled ${encrypted} provider key(s)`);
      return { encrypted, cleared, blocked: 0 };
    })
  );
}

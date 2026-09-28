import type { Database } from "bun:sqlite";
import { encryptSecret, parseMasterKey } from "./secrets";

/**
 * Test-only helper: seal `key` for `providerId` (scope "provider") and insert
 * the assistant_provider_secrets row, so suites that need a decryptable stored
 * provider key do not hand-roll crypto. The master key defaults to
 * process.env.LXK_SECRETS_MASTER_KEY and may be passed explicitly.
 */
export async function seedProviderSecret(
  db: Database,
  providerId: string,
  key: string,
  rawMasterKey?: string
): Promise<void> {
  const raw = rawMasterKey ?? process.env.LXK_SECRETS_MASTER_KEY ?? "";
  if (raw === "") throw new Error("seedProviderSecret requires LXK_SECRETS_MASTER_KEY");
  const master = await parseMasterKey(raw);
  const sealed = await encryptSecret(key, "provider", providerId, master);
  db.prepare(
    `INSERT INTO assistant_provider_secrets (provider_id, ciphertext, iv, key_id, key_hint)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
       key_hint = excluded.key_hint, updated_at = datetime('now')`
  ).run(providerId, sealed.ciphertextB64, sealed.ivB64, sealed.keyId, key.slice(-4));
}

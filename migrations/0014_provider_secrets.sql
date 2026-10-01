-- 0014: LLM provider credentials move from the plaintext assistant_providers.api_key
-- column into envelope-encrypted secret rows. New table only.
--
-- Release N ships THIS file plus the boot backfill. The legacy `api_key` column
-- survives Release N as a dead column: nothing SELECTs it except the one-way
-- backfill (server/db/provider-secrets-backfill.ts), which encrypts every
-- non-empty value into assistant_provider_secrets and then writes '' (the
-- column is NOT NULL). All writes store '' from here on.
--
-- Release N+1 ships 0016_drop_provider_api_key.sql, which removes the column
-- with a guard that aborts while any non-empty api_key remains — so the drop
-- can never destroy an un-backfilled credential. See Phase 4B.
CREATE TABLE assistant_provider_secrets (
  provider_id TEXT PRIMARY KEY REFERENCES assistant_providers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

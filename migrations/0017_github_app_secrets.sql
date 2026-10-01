-- 0017_github_app_secrets.sql — GitHub App credentials move to the encrypted
-- secrets store (scope "github", AAD prefix "lexa-github-v1").
--
-- Numbering note: 0016 is reserved by docs/SCHEMA.md for the future
-- `0016_drop_provider_api_key.sql` (Release N+1). This file takes the next free
-- number so the reserved name stays available; the runner tracks migrations by
-- filename and applies missing files in filename order.
--
-- One row per credential name ('private_key' | 'webhook_secret'); the envelope
-- columns mirror the other per-scope secret tables (assistant_provider_secrets
-- etc.). No FK, no plaintext column. Legacy plaintext `settings.github_*` rows
-- are NOT migrated — they stay readable as a fallback (docs/SCHEMA.md).
CREATE TABLE github_app_secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

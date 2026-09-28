-- 0013: Jev (Typesafe System 1) registry. Config + envelope-encrypted API key
-- + per-project enablement.
--
-- Config moves out of env (TYPESAFE_API_KEY / TYPESAFE_BASE_URL /
-- TYPESAFE_DEFAULT_MODEL are deleted) into a singleton row here; the API key is
-- stored as AES-256-GCM ciphertext in assistant_jev_secrets under the shared
-- secrets keyring (LXK_SECRETS_MASTER_KEY), scoped 'jev' and bound to the
-- config row through the AAD. assistant_jev_projects is opt-in per project.
--
-- New tables only: no ALTER, no rebuild, no data movement, so it is safe on
-- both runners. `INSERT OR IGNORE` seeds the singleton, so re-applying is a
-- no-op and the row always exists for getConfig's LEFT JOIN to hang a secret on.
--
-- The FK cascades under the Workers/D1 runner; the Bun runner executes with
-- `PRAGMA foreign_keys = OFF` (server/db/migrate.ts), where a cascade never
-- fires — but nothing here deletes a config row, so no explicit child delete is
-- needed.

CREATE TABLE assistant_jev_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  base_url TEXT NOT NULL DEFAULT 'https://api.typesafe.ai',
  model TEXT NOT NULL DEFAULT 'jev-latest',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO assistant_jev_config (id) VALUES ('default');

CREATE TABLE assistant_jev_secrets (
  config_id TEXT PRIMARY KEY REFERENCES assistant_jev_config(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,   -- base64, AES-256-GCM (ciphertext||128-bit tag)
  iv TEXT NOT NULL,           -- base64, 12 random bytes per write
  key_id TEXT NOT NULL,       -- 'active' | 'prev'
  key_hint TEXT NOT NULL,     -- last 4 chars of the entered key, display only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistant_jev_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

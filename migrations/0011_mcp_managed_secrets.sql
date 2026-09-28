-- 0011: managed MCP client secrets (envelope encryption).
--
-- A client credential entered in the webapp is stored here as AES-256-GCM
-- ciphertext; the master key never leaves the environment
-- (LXK_MCP_MASTER_KEY, with LXK_MCP_MASTER_KEY_PREV as the rotation read
-- path). `key_id` records the keyring SLOT the blob was encrypted under
-- ('active' | 'prev') — never a fingerprint, counter, or date — so a rotation
-- keeps existing rows readable through the PREV slot and needs no rewrap.
--
-- New table only: no ALTER, no rebuild, no data movement, so it is safe on
-- both runners. Ciphertext is kept out of assistant_mcp_servers on purpose —
-- a `SELECT *` of the registry can never surface a blob, and the registry
-- reads the secret through a LEFT JOIN (absence of a row = no managed token).
--
-- The FK cascades under the Workers/D1 runner, but the Bun runner executes
-- with `PRAGMA foreign_keys = OFF` (server/db/migrate.ts), where the cascade
-- never fires — so repo.remove deletes this row explicitly instead of relying
-- on the parent DELETE alone (same lesson as 0010).

CREATE TABLE assistant_mcp_secrets (
  server_id TEXT PRIMARY KEY REFERENCES assistant_mcp_servers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,                                -- base64, AES-256-GCM (ciphertext||128-bit tag)
  iv TEXT NOT NULL,                                        -- base64, 12 random bytes per write
  key_id TEXT NOT NULL,                                    -- 'active' | 'prev' — the keyring slot
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

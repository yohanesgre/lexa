-- ============================================================
-- Device login requests (CLI pairing flow)
-- ============================================================
-- The CLI cannot authenticate without a credential, so pairing is
-- capability-based: the CLI creates a request and prints a verify
-- URL carrying a 256-bit random token (stored hashed — token_hash
-- UNIQUE doubles as the lookup index, same pattern as
-- api_keys.key_hash). A logged-in user opens the URL and approves;
-- the server mints a USER-BOUND API key (user_id = approver) and
-- the CLI's next poll receives the raw key ONCE (the row is
-- consumed — replay is impossible). Expired rows are purged at boot.
-- (token_hash UNIQUE is a collision/dupe backstop; lookups are by id.)
CREATE TABLE device_login_requests (
  id               TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,          -- hex(SHA-256(token))
  code             TEXT NOT NULL,                 -- short display code (8 chars)
  client_name      TEXT NOT NULL,                 -- "cli-<hostname>"
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  expires_at       TEXT NOT NULL,                 -- datetime('now', '+10 minutes'); compared lexically
  approver_user_id TEXT REFERENCES users(id),     -- set at approve
  api_key_id       TEXT REFERENCES api_keys(id) ON DELETE SET NULL,  -- minted at approve
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
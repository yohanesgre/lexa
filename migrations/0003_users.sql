-- ============================================================
-- Users — auto-registered from CF Access (Google OAuth)
-- ============================================================
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

-- Link API keys to users (nullable — seed key stays unlinked)
ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id);

-- Seed admin user (email from LXK_ADMIN_EMAIL env var at deploy time)
INSERT INTO users (id, email, name, role)
SELECT lower(hex(randomblob(16))), 'admin@lexa.local', 'Admin', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users);

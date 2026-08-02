-- ============================================================
-- 0013 — Allow command-code as a Forge runtime provider
-- ============================================================
-- SQLite cannot ALTER a CHECK constraint; recreate the table.
CREATE TABLE runtimes_new (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  status     TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname   TEXT NOT NULL DEFAULT '',
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO runtimes_new (id, name, provider, status, hostname, last_seen, created_at)
  SELECT id, name, provider, status, hostname, last_seen, created_at FROM runtimes;

DROP TABLE runtimes;
ALTER TABLE runtimes_new RENAME TO runtimes;

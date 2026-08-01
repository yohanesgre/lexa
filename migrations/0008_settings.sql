-- ============================================================
-- Settings KV store — for web-wizard / runtime configuration that
-- must survive container restarts (env can't be rewritten at runtime
-- in Docker). Keys: admin_emails, setup_completed, etc.
-- ============================================================
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

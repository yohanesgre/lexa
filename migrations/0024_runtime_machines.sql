-- ============================================================
-- 0024 — Forge: machine registry
-- ============================================================
CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_machines_last_seen ON machines(last_seen);

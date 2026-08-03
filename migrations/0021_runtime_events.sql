-- ============================================================
-- 0021 — Forge: server-mediated runtime setup events
-- ============================================================
-- The web setup wizard no longer requires copy-paste env blocks. Instead
-- it creates a "runtime event" the logged-in CLI's listener claims over
-- the API (poll pattern). The event carries the chosen agent/model and an
-- API key id; the raw key is delivered ONCE at claim and held in memory,
-- never stored at rest here.
CREATE TABLE runtime_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('install', 'restart')),
  agent       TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at  TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runtime_events_status ON runtime_events(status, created_at);

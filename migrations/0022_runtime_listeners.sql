-- ============================================================
-- 0022 — Forge: CLI listener presence
-- ============================================================
-- The web setup wizard needs to know whether a `lexa-cli runtime listen`
-- is alive on the logged-in machine before offering the one-click flow.
-- The listener heartbeats here (like the daemon does on runtimes); the
-- wizard lists recent listeners and gates on at least one being online.
CREATE TABLE runtime_listeners (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_runtime_listeners_last_seen ON runtime_listeners(last_seen);

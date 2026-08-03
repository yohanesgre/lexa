-- ============================================================
-- 0020 — Forge: per-runtime opencode logging flags
-- ============================================================
-- opencode run supports --print-logs (bool, print logs to stderr) and
-- --log-level (DEBUG|INFO|WARN|ERROR). Stored per runtime so the daemon
-- passes them at spawn time; only applied for the opencode provider.
-- print_logs defaults to false (0); log_level empty = opencode default.
ALTER TABLE runtimes ADD COLUMN print_logs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtimes ADD COLUMN log_level TEXT NOT NULL DEFAULT '';

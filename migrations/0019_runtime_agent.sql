-- ============================================================
-- 0019 — Forge: per-runtime agent flag (CLI's internal agent)
-- ============================================================
-- opencode's --agent selects the agent persona (e.g. build, plan).
-- Stored per runtime so the daemon passes it at spawn time; empty
-- means the CLI's default agent.
ALTER TABLE runtimes ADD COLUMN agent TEXT NOT NULL DEFAULT '';

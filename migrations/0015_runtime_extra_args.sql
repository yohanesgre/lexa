-- ============================================================
-- 0015 — Runtime extra args: server-injected CLI tokens
-- ============================================================
ALTER TABLE runtimes ADD COLUMN extra_args TEXT NOT NULL DEFAULT '[]';

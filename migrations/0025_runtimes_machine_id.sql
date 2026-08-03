-- ============================================================
-- 0025 — Forge: link runtimes to their machine
-- ============================================================
ALTER TABLE runtimes ADD COLUMN machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL;
CREATE INDEX idx_runtimes_machine ON runtimes(machine_id);

-- ============================================================
-- 0026 — Forge: CLI-reported agent catalog
-- ============================================================
-- The lexa-cli listener discovers installed agent personas and reports them
-- alongside the model catalog. The daemon never needs to discover these.
ALTER TABLE runtimes ADD COLUMN agents_catalog TEXT NOT NULL DEFAULT '[]';

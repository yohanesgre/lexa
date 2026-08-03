-- 0016 — Runtime model catalog: provider-aware models reported by the daemon
ALTER TABLE runtimes ADD COLUMN models_catalog TEXT NOT NULL DEFAULT '[]';

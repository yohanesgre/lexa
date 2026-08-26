-- Herald Gateway fallback persistence + priority reorder race (edges 2,9)
-- Fallback chain persisted as JSON array of herald_models ids (deduped, ≤3, ordered).
-- Priority reorder must be atomic 0..n; add unique index for race detection + deterministic ordering.

ALTER TABLE herald_settings ADD COLUMN fallback_model_ids TEXT NOT NULL DEFAULT '[]';

CREATE UNIQUE INDEX IF NOT EXISTS idx_herald_models_provider_priority ON herald_models(provider_id, priority);

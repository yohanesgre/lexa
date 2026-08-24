-- Reasoning effort (docs/SCHEMA.md — migration 0014). Project-level default
-- for Herald lanes; NULL = unset (no reasoning_effort param sent upstream).
-- Per-turn chat overrides live only in the request payload, never persisted.

ALTER TABLE herald_settings ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IN ('minimal','low','medium','high'));

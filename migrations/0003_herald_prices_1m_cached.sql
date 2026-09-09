-- ============================================================
-- Herald model prices: USD per-1M tokens + cached tiers
-- ============================================================
-- OpenRouter quotes USD per token; the 0001 seed stored those raw
-- strings. Standardize on USD per 1M tokens (what the admin UI and
-- cost math use) and add cached input/output tiers. D1-compatible:
-- ADD COLUMN + UPDATE only.
ALTER TABLE herald_model_prices ADD COLUMN cached_read_price REAL NOT NULL DEFAULT 0;
ALTER TABLE herald_model_prices ADD COLUMN cached_write_price REAL NOT NULL DEFAULT 0;
UPDATE herald_model_prices
  SET prompt_price = prompt_price * 1000000.0,
      completion_price = completion_price * 1000000.0;

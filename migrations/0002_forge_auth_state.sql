-- Forge machine hosting + key-revocation state.
-- machines.clis: installed agent CLIs reported by the listener heartbeat
--   (JSON array of { provider, version }).
-- runtimes.last_error: last daemon failure reported via machine heartbeat
--   (e.g. "API key revoked") — cleared on daemon register/heartbeat success.
ALTER TABLE machines ADD COLUMN clis TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runtimes ADD COLUMN last_error TEXT;

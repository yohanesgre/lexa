-- Herald provider health / circuit breaker (pla-1)
CREATE TABLE herald_provider_health (
  provider_id TEXT PRIMARY KEY REFERENCES herald_providers(id) ON DELETE CASCADE,
  failure_count INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('open','closed','half-open')) DEFAULT 'closed',
  opened_at TEXT,
  last_probe_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

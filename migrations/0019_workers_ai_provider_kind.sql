-- H9: add the `workers_ai` provider kind (keyless Workers AI via the `env.AI`
-- binding). SQLite cannot ALTER a CHECK, so both `kind` CHECKs are rebuilt with
-- the create/copy/drop/rename pattern. D1-compatible: `RENAME TO` is supported,
-- `RENAME COLUMN` is not used, and neither table has an inbound FK, so FKs stay
-- enforced for the whole run. Every row is copied verbatim — only the allowed
-- kind set widens.

-- assistant_models: rebuild with the widened CHECK.
CREATE TABLE assistant_models_new (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES assistant_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses','workers_ai')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO assistant_models_new (id, provider_id, model_id, kind, priority, enabled, created_at)
  SELECT id, provider_id, model_id, kind, priority, enabled, created_at FROM assistant_models;
DROP TABLE assistant_models;
ALTER TABLE assistant_models_new RENAME TO assistant_models;
CREATE INDEX idx_assistant_models_provider ON assistant_models(provider_id);
CREATE UNIQUE INDEX idx_assistant_models_provider_priority ON assistant_models(provider_id, priority);

-- assistant_call_logs: rebuild with the widened CHECK.
CREATE TABLE assistant_call_logs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES assistant_providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses','workers_ai')),
  status TEXT NOT NULL CHECK (status IN ('done','error','suspended','aborted')),
  error_code TEXT,
  usage_in INTEGER NOT NULL DEFAULT 0,
  usage_out INTEGER NOT NULL DEFAULT 0,
  cached_in INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO assistant_call_logs_new (id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated, created_at)
  SELECT id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated, created_at FROM assistant_call_logs;
DROP TABLE assistant_call_logs;
ALTER TABLE assistant_call_logs_new RENAME TO assistant_call_logs;
CREATE INDEX idx_call_logs_project_time ON assistant_call_logs(project_id, created_at);
CREATE INDEX idx_call_logs_provider ON assistant_call_logs(provider_id);
CREATE INDEX idx_call_logs_model ON assistant_call_logs(model);

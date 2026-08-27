-- Herald responses kind: allow openai_responses for OpenCode Go Responses API (/v1/responses via createOpenaiChat)
CREATE TABLE herald_models_new (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES herald_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO herald_models_new (id, provider_id, model_id, kind, priority, enabled, created_at)
  SELECT id, provider_id, model_id, kind, priority, enabled, created_at FROM herald_models;
DROP TABLE herald_models;
ALTER TABLE herald_models_new RENAME TO herald_models;
CREATE INDEX idx_herald_models_provider ON herald_models(provider_id);
CREATE UNIQUE INDEX idx_herald_models_provider_priority ON herald_models(provider_id, priority);

CREATE TABLE herald_call_logs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES herald_providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses')),
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
INSERT INTO herald_call_logs_new (id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated, created_at)
  SELECT id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated, created_at FROM herald_call_logs;
DROP TABLE herald_call_logs;
ALTER TABLE herald_call_logs_new RENAME TO herald_call_logs;
CREATE INDEX idx_call_logs_project_time ON herald_call_logs(project_id, created_at);
CREATE INDEX idx_call_logs_provider ON herald_call_logs(provider_id);
CREATE INDEX idx_call_logs_model ON herald_call_logs(model);

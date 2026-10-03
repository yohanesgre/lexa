-- 0023_assistant_call_log_rebuild.sql — call-log attribution (H8 observability).
--
-- Adds three columns to `assistant_call_logs`:
--   thread_key — the `<documentType>:<documentId>` thread the call belonged to
--   run_id     — the delegated run id, when the call was a runner turn
--   purpose    — which assistant flow issued the call, CHECK-pinned to
--                ('turn','runner','preflight','summary'); existing rows default
--                to 'turn'.
-- SQLite cannot ALTER a CHECK, and the new `purpose` column carries one, so the
-- table is rebuilt create/copy/drop/rename following 0019. Every row is copied
-- verbatim; the three call-log indexes are recreated. No inbound FK targets
-- `assistant_call_logs`, so the rebuild is FK-safe under D1's enforced keys.

CREATE TABLE assistant_call_logs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES assistant_providers(id) ON DELETE SET NULL,
  thread_key TEXT,
  run_id TEXT,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses','workers_ai')),
  status TEXT NOT NULL CHECK (status IN ('done','error','suspended','aborted')),
  purpose TEXT NOT NULL DEFAULT 'turn' CHECK (purpose IN ('turn','runner','preflight','summary')),
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

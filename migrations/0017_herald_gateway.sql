-- Herald Gateway C1 Phase 1 (docs/SCHEMA.md): hard migrate herald_settings + provider gateway.
-- Drops legacy per-project provider columns (kind, base_url, api_key, model, vision_model) — no compat.

CREATE TABLE herald_settings_new (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  search_provider TEXT,
  search_api_key TEXT,
  url_allowlist TEXT,
  engine TEXT NOT NULL DEFAULT 'herald' CHECK (engine IN ('herald','blacksmith')),
  engine_switcher_enabled INTEGER NOT NULL DEFAULT 0,
  primary_supports_images INTEGER NOT NULL DEFAULT 0,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('minimal','low','medium','high')),
  write_tools TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO herald_settings_new (project_id, search_provider, search_api_key, url_allowlist, engine, engine_switcher_enabled, primary_supports_images, reasoning_effort, write_tools, created_at, updated_at)
  SELECT project_id, search_provider, search_api_key, url_allowlist, engine, engine_switcher_enabled, primary_supports_images, reasoning_effort, write_tools, created_at, updated_at FROM herald_settings;
DROP TABLE herald_settings;
ALTER TABLE herald_settings_new RENAME TO herald_settings;

-- Global providers (no project_id) — superadmin-only at the API layer.
CREATE TABLE herald_providers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE herald_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES herald_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_herald_models_provider ON herald_models(provider_id);

CREATE TABLE herald_call_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES herald_providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible')),
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
CREATE INDEX idx_call_logs_project_time ON herald_call_logs(project_id, created_at);
CREATE INDEX idx_call_logs_provider ON herald_call_logs(provider_id);
CREATE INDEX idx_call_logs_model ON herald_call_logs(model);

CREATE TABLE herald_model_prices (
  model TEXT PRIMARY KEY,
  prompt_price REAL NOT NULL DEFAULT 0,
  completion_price REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

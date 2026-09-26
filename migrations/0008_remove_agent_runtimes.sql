-- 0008: remove the blacksmith/coding-agent runtime tier.
-- Queue is rebuilt+renamed (no DROP COLUMN); assistant-lane rows survive
-- and are rebound to the single builtin agent. Operational machine state is
-- dropped. Bun runner runs FKs OFF, so junction deletes are explicit.

-- 1) logs (child of the queue) + warm sessions die with the tier
DROP TABLE runtime_task_logs;
DROP TABLE runtime_sessions;

-- 2) runtime_tasks -> assistant_tasks (trim runtime_id, kind, doc_context)
CREATE TABLE assistant_tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES lexa_agents(id),
  skill_id      TEXT NOT NULL REFERENCES lexa_skills(id),
  extra_prompt  TEXT NOT NULL DEFAULT '',
  selection     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id,
  extra_prompt, selection, status, result, error, created_at, started_at, finished_at)
  SELECT id, project_id, document_type, document_id,
         CASE WHEN agent_id = 'blacksmith' THEN 'assistant' ELSE agent_id END,
         skill_id, extra_prompt, selection, status, result, error, created_at, started_at, finished_at
  FROM runtime_tasks;
DROP TABLE runtime_tasks;
CREATE INDEX idx_assistant_tasks_created ON assistant_tasks(created_at DESC, id DESC);
CREATE INDEX idx_assistant_tasks_status ON assistant_tasks(status, created_at);

-- 3) document threads off the removed agent (no FK; keeps transcripts)
UPDATE assistant_threads SET agent_id = 'assistant' WHERE agent_id = 'blacksmith';

-- 4) machine/runtime registry (children before parents)
DROP TABLE runtime_events;
DROP TABLE runtimes;
DROP TABLE machines;

-- 5) assistant_settings without engine/engine_switcher_enabled
CREATE TABLE assistant_settings_new (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  search_provider TEXT,
  search_api_key TEXT,
  url_allowlist TEXT,
  primary_supports_images INTEGER NOT NULL DEFAULT 0,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('minimal','low','medium','high')),
  write_tools TEXT NOT NULL DEFAULT '',
  fallback_model_ids TEXT NOT NULL DEFAULT '[]',
  provider_id TEXT REFERENCES assistant_providers(id) ON DELETE SET NULL,
  primary_model_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO assistant_settings_new (project_id, search_provider, search_api_key, url_allowlist,
  primary_supports_images, reasoning_effort, write_tools, fallback_model_ids,
  provider_id, primary_model_id, created_at, updated_at)
  SELECT project_id, search_provider, search_api_key, url_allowlist,
         primary_supports_images, reasoning_effort, write_tools, fallback_model_ids,
         provider_id, primary_model_id, created_at, updated_at
  FROM assistant_settings;
DROP TABLE assistant_settings;
ALTER TABLE assistant_settings_new RENAME TO assistant_settings;

-- 6) catalog: one builtin agent (junction rows explicit — Bun runner FKs OFF)
DELETE FROM lexa_agent_skills WHERE agent_id = 'blacksmith';
DELETE FROM lexa_agents WHERE id = 'blacksmith';

-- 7) legacy repo-cap key
UPDATE OR REPLACE settings SET key = 'assistant_repo_cap' WHERE key = 'runtime_repo_cap';

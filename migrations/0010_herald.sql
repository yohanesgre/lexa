-- Herald assistant tier (see docs/ADR-0001-two-tier-ai-architecture.md).

CREATE TABLE herald_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible')),
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  search_provider TEXT,
  search_api_key TEXT,
  url_allowlist TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE forge_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'blacksmith';

CREATE INDEX idx_forge_tasks_kind_status ON forge_tasks(kind, status);

CREATE TABLE herald_threads (
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  agent_id TEXT,
  skill_id TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_type, document_id)
);

CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE project_memory_fts USING fts5(content, content='project_memory', content_rowid='rowid');

ALTER TABLE forge_agents RENAME TO lexa_agents;
ALTER TABLE forge_skills RENAME TO lexa_skills;
ALTER TABLE forge_agent_skills RENAME TO lexa_agent_skills;

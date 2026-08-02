-- ============================================================
-- 0011 — Forge: runtime agents + persisted document sources
-- ============================================================

-- Registered Forge daemons (runtimes). A daemon runs on a machine
-- with agent CLIs installed (opencode/hermes) and polls for tasks.
CREATE TABLE runtimes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes')),
  status     TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname   TEXT NOT NULL DEFAULT '',
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Forge task queue. One row per writing-assist request from an editor.
CREATE TABLE forge_tasks (
  id            TEXT PRIMARY KEY,
  runtime_id    TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('continue', 'rewrite', 'summarize', 'expand', 'grammar')),
  selection     TEXT NOT NULL DEFAULT '',
  doc_context   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX idx_forge_tasks_status ON forge_tasks(status, created_at);

-- Persisted per-document sources (wiki page or external URL) used by Forge.
CREATE TABLE document_sources (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('wiki', 'external')),
  title         TEXT NOT NULL DEFAULT '',
  -- For wiki kind: the target wiki page slug. For external kind: the URL.
  ref           TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_type, document_id, kind, ref)
);
CREATE INDEX idx_sources_document ON document_sources(document_type, document_id);

-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Kanban Columns
-- ============================================================
CREATE TABLE columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,
  color           TEXT NOT NULL DEFAULT '#6b7280',
  wip_limit       INTEGER,
  required_fields TEXT NOT NULL DEFAULT '[]',
  github_state    TEXT CHECK (github_state IN ('open','closed'))
);

-- ============================================================
-- Swimlanes
-- ============================================================
CREATE TABLE swimlanes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL
);

-- ============================================================
-- Tasks
-- ============================================================
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id           TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
  swimlane_id         TEXT REFERENCES swimlanes(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '{}',
  priority            TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('urgent','high','medium','low')),
  type                TEXT NOT NULL DEFAULT 'task'
                        CHECK (type IN ('feature','bug','task','asset')),
  assignee            TEXT,
  position            TEXT NOT NULL,
  github_issue_id     TEXT UNIQUE,
  github_issue_number INTEGER,
  github_repo         TEXT,
  github_synced_state TEXT CHECK (github_synced_state IN ('open','closed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(column_id, position)
);

-- ============================================================
-- Wiki Pages
-- ============================================================
CREATE TABLE wiki_pages (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '{}',
  content_text TEXT NOT NULL DEFAULT '',
  parent_id    TEXT REFERENCES wiki_pages(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

CREATE VIRTUAL TABLE wiki_fts USING fts5(
  title,
  content_text,
  content='wiki_pages',
  content_rowid='rowid'
);

CREATE TRIGGER wiki_fts_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER wiki_fts_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
END;

CREATE TRIGGER wiki_fts_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

-- ============================================================
-- API Keys
-- ============================================================
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- ============================================================
-- Webhook event dedup
-- ============================================================
CREATE TABLE webhook_events (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_tasks_board     ON tasks(project_id, column_id, position);
CREATE INDEX idx_tasks_swimlane  ON tasks(project_id, swimlane_id);
CREATE INDEX idx_columns_project ON columns(project_id, position);
CREATE INDEX idx_swimlanes_proj  ON swimlanes(project_id, position);
CREATE INDEX idx_wiki_project    ON wiki_pages(project_id);
CREATE INDEX idx_wiki_parent     ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;

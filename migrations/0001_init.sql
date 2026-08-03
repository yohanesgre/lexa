-- Lexa schema v0.1.0 (squashed 0001..0027 into a single clean migration — 2026-08-04).
-- Unreleased squash: no intermediate rebuild/backfill steps, just the final
-- schema plus the Forge builtin seeds. No placeholder admin: users
-- auto-register on first CF Access login; admin role from LXK_ADMIN_EMAILS /
-- settings.admin_emails.

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
, user_id TEXT REFERENCES users(id));

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

CREATE TABLE forge_agent_skills (
  agent_id TEXT NOT NULL REFERENCES forge_agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES forge_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE forge_agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_task_logs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES "forge_tasks_old"(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_tasks (
  id            TEXT PRIMARY KEY,
  runtime_id    TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES forge_agents(id),
  skill_id      TEXT NOT NULL REFERENCES forge_skills(id),
  extra_prompt  TEXT NOT NULL DEFAULT '',
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

CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE priority_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runtime_events (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'install'
                CHECK (action IN ('install', 'update', 'remove')),
  agent_cli   TEXT NOT NULL
                CHECK (agent_cli IN ('opencode','hermes','command-code')),
  api_key_id  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','completed','failed')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at  TEXT,
  finished_at TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);

CREATE TABLE runtime_listeners (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "runtimes" (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  model      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname   TEXT NOT NULL DEFAULT '',
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, extra_args TEXT NOT NULL DEFAULT '[]', models_catalog TEXT NOT NULL DEFAULT '[]', mcp_connected INTEGER NOT NULL DEFAULT 0, agent TEXT NOT NULL DEFAULT '', print_logs INTEGER NOT NULL DEFAULT 0, log_level TEXT NOT NULL DEFAULT '', machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL, agents_catalog TEXT NOT NULL DEFAULT '[]');

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE swimlanes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL
);

CREATE TABLE task_assignees (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  PRIMARY KEY (task_id, user_name)
);

CREATE TABLE task_github_issues (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  repo          TEXT NOT NULL,
  synced_state  TEXT CHECK (synced_state IN ('open','closed')),
  PRIMARY KEY (task_id, issue_id)
);

CREATE TABLE task_links (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN ('subtask_of', 'blocked_by', 'related_to')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_task_id, to_task_id, relation)
);

CREATE TABLE "tasks" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES columns(id),
  swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
  priority TEXT NOT NULL DEFAULT 'medium',
  type TEXT NOT NULL DEFAULT 'task',
  position TEXT NOT NULL,
  github_issue_id TEXT,
  github_issue_number INTEGER,
  github_repo TEXT,
  github_synced_state TEXT CHECK (github_synced_state IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, archived_at TEXT);

CREATE TABLE type_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);

CREATE TABLE user_project_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role, project_id)
);

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

CREATE TABLE webhook_events (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE wiki_fts USING fts5(
  title,
  content_text,
  content='wiki_pages',
  content_rowid='rowid'
);

CREATE TABLE wiki_page_revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_text TEXT NOT NULL DEFAULT '',
  save_type    TEXT NOT NULL CHECK (save_type IN ('autosave', 'manual')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE INDEX idx_columns_project ON columns(project_id, position);

CREATE INDEX idx_forge_task_logs_task ON forge_task_logs(task_id, created_at);

CREATE INDEX idx_forge_tasks_status ON forge_tasks(status, created_at);

CREATE INDEX idx_machines_last_seen ON machines(last_seen);

CREATE INDEX idx_priority_options_project ON priority_options(project_id, position);

CREATE INDEX idx_revisions_page ON wiki_page_revisions(page_id, created_at DESC);

CREATE INDEX idx_runtime_events_machine ON runtime_events(machine_id, status);

CREATE INDEX idx_runtime_events_status ON runtime_events(status, created_at);

CREATE INDEX idx_runtime_listeners_last_seen ON runtime_listeners(last_seen);

CREATE INDEX idx_runtimes_machine ON runtimes(machine_id);

CREATE INDEX idx_sources_document ON document_sources(document_type, document_id);

CREATE INDEX idx_swimlanes_proj  ON swimlanes(project_id, position);

CREATE INDEX idx_task_links_from ON task_links(from_task_id);

CREATE INDEX idx_task_links_proj ON task_links(project_id);

CREATE INDEX idx_task_links_to   ON task_links(to_task_id);

CREATE INDEX idx_type_options_project ON type_options(project_id, position);

CREATE INDEX idx_wiki_parent     ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX idx_wiki_project    ON wiki_pages(project_id);

CREATE TRIGGER wiki_fts_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
END;

CREATE TRIGGER wiki_fts_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER wiki_fts_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES
  ('lexa', 'Lexa',
   'Default writing assistant — matches the document''s voice, outputs only text.',
   'You are Forge, a writing assistant inside Lexa. You help a game-dev team write task descriptions and wiki pages. You are a text editor, not an agent: you do not call tools, you do not read files, and you do not act on any system. Your whole output is the text you write.',
   1);

INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES
  ('continue', 'Continue',
   'Continue the text naturally from the cursor, matching its style, tone, and structure.',
   'Continue the text below naturally, matching its style, tone, and structure. Output only the continuation, no preamble.',
   1),
  ('rewrite', 'Rewrite',
   'Make the selected text clearer and more concise without changing the meaning.',
   'Rewrite the selected text to be clearer and more concise. Keep the meaning. Keep the same structure and level of detail — tighten the prose, don''t restructure arbitrarily. Output only the rewritten text.',
   1),
  ('summarize', 'Summarize',
   'Condense the selected text into an overview plus key-point bullets.',
   'Summarize the selected text. Lead with a 1–2 sentence overview, then 3–6 bullets of the key points. Keep it tight. Output only the summary.',
   1),
  ('expand', 'Expand',
   'Expand the selected text into more detail, keeping the same voice.',
   'Expand the selected text into more detail, keeping the same voice. Break it into labeled sections with subheadings and add concrete examples or specifics where they help. Output only the expanded text.',
   1),
  ('grammar', 'Fix grammar',
   'Fix grammar, spelling, and punctuation without changing meaning or formatting.',
   'Fix grammar, spelling, and punctuation in the selected text. Do not change meaning, style, or structure — preserve the exact formatting. Output only the corrected text.',
   1);

INSERT INTO forge_agent_skills (agent_id, skill_id) VALUES
  ('lexa', 'continue'), ('lexa', 'rewrite'), ('lexa', 'summarize'), ('lexa', 'expand'), ('lexa', 'grammar');

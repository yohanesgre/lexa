-- Lexa baseline schema (squashed 2026-09-07 for the 2026.1.0 CalVer release).
--
-- Supersedes migrations 0001-0024: every CREATE/ALTER/seed from the pre-release
-- chain is folded here at its FINAL state. Transitional steps (Forge->Hearth
-- renames, dropped columns, data backfills/fixups over rows that only exist on
-- upgraded databases) are no-ops on a fresh database and are intentionally
-- absent. There are no tagged releases before 2026.1.0, so no live database
-- carries the old _migrations rows — a fresh database applies exactly this
-- file. Future migrations continue at 0025_*.sql.
--
-- Verified equivalent to applying 0001-0024 in order (schema + seed dump-diff).
-- D1 note: PRAGMA defer_foreign_keys (same pattern as the old 0013) keeps the
-- seed INSERTs identical on both engines; D1 applies with FKs enforced.

PRAGMA defer_foreign_keys = ON;

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
, is_done INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE "lexa_agent_skills" (
  agent_id TEXT NOT NULL REFERENCES "lexa_agents"(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES "lexa_skills"(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);
CREATE TABLE "lexa_agents" (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE "lexa_skills" (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE "hearth_task_logs" (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES "hearth_tasks"(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  -- stream/level: the daemon classifies each log line ONCE at write time
  -- (shared/forge-log.ts); the UI renders the stored level, no text matching
  -- at render time.
  stream     TEXT NOT NULL DEFAULT 'out',
  level      TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE "hearth_tasks" (
  id            TEXT PRIMARY KEY,
  runtime_id    TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES "lexa_agents"(id),
  skill_id      TEXT NOT NULL REFERENCES "lexa_skills"(id),
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
, kind TEXT NOT NULL DEFAULT 'blacksmith');
CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  -- clis: installed agent CLIs reported by the listener heartbeat
  --   (JSON array of { provider, version }).
  clis        TEXT NOT NULL DEFAULT '[]',
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- secret: machine→host binding secret, minted once at first registration
  -- (F1 closure). Sent as x-machine-secret on runtime-event claims; legacy
  -- rows keep '' and must be removed + re-registered. Kept LAST to match the
  -- historical ALTER TABLE ADD COLUMN order.
  secret      TEXT NOT NULL DEFAULT ''
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, team_id TEXT REFERENCES organization(id) ON DELETE SET NULL, key TEXT, next_task_number INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE "runtimes" (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  model      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname   TEXT NOT NULL DEFAULT '',
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, extra_args TEXT NOT NULL DEFAULT '[]', models_catalog TEXT NOT NULL DEFAULT '[]', agent TEXT NOT NULL DEFAULT '', print_logs INTEGER NOT NULL DEFAULT 0, log_level TEXT NOT NULL DEFAULT '', machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL, agents_catalog TEXT NOT NULL DEFAULT '[]', last_error TEXT, team_id TEXT REFERENCES organization(id) ON DELETE SET NULL);
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  synced_state  TEXT CHECK (synced_state IN ('open','closed')), pushed_title TEXT, pushed_body TEXT, push_failed INTEGER NOT NULL DEFAULT 0,
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
, archived_at TEXT, due_at TEXT, key TEXT, number INTEGER);
CREATE TABLE task_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL: agent/system
  author_kind  TEXT NOT NULL DEFAULT 'user'
               CHECK (author_kind IN ('user','agent','system')),
  author_label TEXT NOT NULL,        -- frozen at write time
  body         TEXT NOT NULL,        -- TipTap JSON doc (≤64KB, non-empty)
  edited_at    TEXT,                 -- set on edit → UI "edited" marker
  deleted_at   TEXT,                 -- soft delete → hidden from timeline
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
, via_herald INTEGER NOT NULL DEFAULT 0);
CREATE TABLE task_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_label   TEXT NOT NULL,       -- frozen display name
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                                     -- agent: key owner; user: their id; NULL: unbound/system
  type          TEXT NOT NULL,       -- enum in shared/types.ts (no CHECK — growing set)
  message       TEXT NOT NULL,       -- frozen at write time; the record
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
, via_herald INTEGER NOT NULL DEFAULT 0);
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
CREATE INDEX idx_machines_last_seen ON machines(last_seen);
CREATE INDEX idx_priority_options_project ON priority_options(project_id, position);
CREATE INDEX idx_revisions_page ON wiki_page_revisions(page_id, created_at DESC);
CREATE INDEX idx_runtime_events_machine ON runtime_events(machine_id, status);
CREATE INDEX idx_runtime_events_status ON runtime_events(status, created_at);
CREATE INDEX idx_runtimes_machine ON runtimes(machine_id);
CREATE INDEX idx_sources_document ON document_sources(document_type, document_id);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);
CREATE UNIQUE INDEX idx_task_github_issues_issue ON task_github_issues(issue_id);
CREATE INDEX idx_task_links_from ON task_links(from_task_id);
CREATE INDEX idx_task_links_proj ON task_links(project_id);
CREATE INDEX idx_task_links_to   ON task_links(to_task_id);
CREATE INDEX idx_tasks_board     ON tasks(project_id, column_id, position);
CREATE UNIQUE INDEX idx_tasks_position  ON tasks(column_id, position);
CREATE INDEX idx_tasks_swimlane  ON tasks(project_id, swimlane_id);
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
CREATE TABLE project_repos (
  id              TEXT PRIMARY KEY,                          -- UUID
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,                             -- "owner/name"
  source_role     INTEGER NOT NULL DEFAULT 0,                -- Forge context + project label
  workspace_role  INTEGER NOT NULL DEFAULT 0,                -- issue link/create/sync
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_project_repos_unique ON project_repos(project_id, repo);
CREATE INDEX idx_project_repos_repo ON project_repos(repo);
CREATE TABLE "hearth_sessions" (
  document_type   TEXT    NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id     TEXT    NOT NULL,
  runtime_id      TEXT    NOT NULL,
  runtime_session_id TEXT NOT NULL,
  provider        TEXT    NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  agent_id        TEXT    NOT NULL,
  skill_id        TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_type, document_id, runtime_id)
);
CREATE TABLE "users" (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('superadmin', 'member')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen      TEXT,
  email_verified INTEGER NOT NULL DEFAULT 1,
  image          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- admin plugin (R16 user lifecycle: ban = deactivate) — camelCase columns,
  -- the plugin queries them verbatim
  banned         INTEGER NOT NULL DEFAULT 0,
  banReason      TEXT,
  banExpires     TEXT);
CREATE TABLE organization (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  logo       TEXT,
  createdAt  TEXT NOT NULL,
  metadata   TEXT
);
CREATE TABLE member (
  id             TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  UNIQUE(organizationId, userId)
);
CREATE TABLE session (
  id                    TEXT PRIMARY KEY,
  expiresAt             TEXT NOT NULL,
  token                 TEXT NOT NULL UNIQUE,
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL,
  ipAddress             TEXT,
  userAgent             TEXT,
  userId                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activeOrganizationId  TEXT
, impersonatedBy TEXT);
CREATE TABLE account (
  id                    TEXT PRIMARY KEY,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  password              TEXT,
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL
);
CREATE TABLE verification (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expiresAt   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX session_userId_idx ON session(userId);
CREATE INDEX account_userId_idx ON account(userId);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE INDEX member_organizationId_idx ON member(organizationId);
CREATE INDEX member_userId_idx ON member(userId);
CREATE TABLE workspace_invitations (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX idx_projects_team ON projects(team_id);
CREATE INDEX idx_runtimes_team ON runtimes(team_id);
CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  due_at      TEXT,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_proj ON milestones(project_id, position);
CREATE TABLE "swimlanes" (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  due_at      TEXT,
  archived_at TEXT,
  start_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'sprint'
              CHECK (kind IN ('backlog','sprint')),
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';
CREATE INDEX idx_swimlanes_proj ON swimlanes(project_id, position);
CREATE INDEX idx_swimlanes_milestone ON swimlanes(project_id, milestone_id, position);
CREATE UNIQUE INDEX idx_projects_key ON projects(key);
CREATE UNIQUE INDEX idx_tasks_project_number ON tasks(project_id, number);
CREATE TABLE wiki_share_links (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wiki_share_links_page ON wiki_share_links(page_id);
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  wiki_page_id  TEXT REFERENCES wiki_pages(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((task_id IS NULL) != (wiki_page_id IS NULL)),
  UNIQUE(project_id, sha256)
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_wiki_page ON attachments(wiki_page_id);
CREATE INDEX idx_attachments_storage_key ON attachments(storage_key);
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), title TEXT, pinned INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX idx_herald_threads_chat_list ON herald_threads(project_id, owner_user_id, pinned DESC, updated_at DESC)
  WHERE document_type = 'chat';
CREATE INDEX idx_hearth_tasks_created ON hearth_tasks(created_at DESC, id DESC);
CREATE INDEX idx_hearth_tasks_status ON hearth_tasks(status, created_at);
CREATE INDEX idx_hearth_task_logs_task ON hearth_task_logs(task_id, created_at);
CREATE INDEX idx_hearth_tasks_kind_status ON hearth_tasks(kind, status);
CREATE TABLE herald_pending_writes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  execution_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (document_type, document_id) REFERENCES herald_threads(document_type, document_id) ON DELETE CASCADE
);
CREATE INDEX idx_herald_pending_batch ON herald_pending_writes(batch_id, seq);
CREATE INDEX idx_herald_pending_thread ON herald_pending_writes(document_type, document_id, status);
CREATE TABLE "herald_settings" (
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
, fallback_model_ids TEXT NOT NULL DEFAULT '[]', provider_id TEXT REFERENCES herald_providers(id) ON DELETE SET NULL, primary_model_id TEXT);
CREATE TABLE herald_providers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE herald_model_prices (
  model TEXT PRIMARY KEY,
  prompt_price REAL NOT NULL DEFAULT 0,
  completion_price REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE herald_provider_health (
  provider_id TEXT PRIMARY KEY REFERENCES herald_providers(id) ON DELETE CASCADE,
  failure_count INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('open','closed','half-open')) DEFAULT 'closed',
  opened_at TEXT,
  last_probe_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "herald_models" (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES herald_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_herald_models_provider ON herald_models(provider_id);
CREATE UNIQUE INDEX idx_herald_models_provider_priority ON herald_models(provider_id, priority);
CREATE TABLE "herald_call_logs" (
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
CREATE INDEX idx_call_logs_project_time ON herald_call_logs(project_id, created_at);
CREATE INDEX idx_call_logs_provider ON herald_call_logs(provider_id);
CREATE INDEX idx_call_logs_model ON herald_call_logs(model);
CREATE TABLE invitation (
  id             TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  teamId         TEXT,
  inviterId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt      TEXT NOT NULL,
  createdAt      TEXT NOT NULL
);
CREATE INDEX invitation_organizationId_idx ON invitation(organizationId);
CREATE INDEX invitation_email_idx ON invitation(email);
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'requirements');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'deliverables');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'review');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'definition-of-done');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'status');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-herald', 'polish');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-blacksmith', 'definition-of-done');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-blacksmith', 'requirements');
INSERT INTO "lexa_agent_skills" ("agent_id", "skill_id") VALUES ('hearth-blacksmith', 'review');
INSERT INTO "lexa_agents" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('hearth-herald', 'Herald Agent', 'Default project assistant — writes and sharpens task descriptions, requirements, and wiki pages.', 'You are the Herald Agent, Lexa''s companion project-management assistant. You help teams run their projects: you draft and sharpen task descriptions, requirements, and wiki pages, spot missing details, unclear scope, and weak acceptance criteria, and answer questions about the project. You may read files in your working directory (the project workspace) to ground your writing in the actual repo and docs. You do not write files, run commands, or act on any system — your whole output is the text you write. Match the document''s existing voice and structure. If the linked sources contradict the document, prefer the sources.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_agents" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('hearth-blacksmith', 'Blacksmith Agent', '', 'You are the Blacksmith Agent, a coding agent working inside a persistent project workspace. You implement, refactor, and debug code: read the repository, plan the change, apply it, and verify with builds or tests where possible. Follow the project''s existing conventions and keep changes minimal and focused. When a task is ambiguous, choose the smallest reasonable interpretation and state your assumption in the final summary.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('requirements', 'Requirements', 'Write clear, testable requirements for a task.', 'Write only the task''s requirements — what must hold when it''s done. One concrete, verifiable condition per checkbox item (- [ ]). No design proposals or background. Output only the checklist.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('deliverables', 'Deliverables', 'Break a task into deliverables.', 'Split the task into a checklist of deliverables — concrete, actionable outputs. Each must be independently completable. Note dependencies. Output only the checklist.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('review', 'Review', 'Improve a task''s clarity and completeness like a PM.', 'Review the task like a project manager: fix missing details, unclear scope, weak requirements, and risks. Output the improved full task — not a separate report.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('definition-of-done', 'Definition of done', 'Write a Definition of Done checklist for a task.', 'Write a Definition of Done checklist (- [ ]): conditions that must hold before the task counts as complete. Each item concrete and verifiable. Output only the checklist.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('status', 'Status', 'Write a status update: progress, blockers, next steps.', 'Write a status update: what''s done, what''s blocked (and why), what''s next. Be honest; flag risks early. Output only the status update.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');
INSERT INTO "lexa_skills" ("id", "name", "description", "instructions", "is_builtin", "created_at", "updated_at") VALUES ('polish', 'Polish', 'Refine the selected text: clearer, more concise, same meaning.', 'Polish the selected text: clearer and more concise, keeping the meaning, structure, and level of detail. Output only the polished text.', 1, '2026-09-06 17:07:51', '2026-09-06 17:07:51');

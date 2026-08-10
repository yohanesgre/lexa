# SQLite Schema

## Full Schema

```sql
-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,                              -- UUID (crypto.randomUUID())
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,                          -- duplicate → SlugTaken 409
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT,                                          -- "owner/repo"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))        -- maintained by app on every UPDATE
);

-- ============================================================
-- Users + project roles
-- ============================================================
-- Users auto-register on first CF Access login; the global role comes from
-- LXK_ADMIN_EMAILS / settings.admin_emails (env OR settings checked at auth).
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);

-- Per-project roles. PRIMARY KEY includes role: a user holds at most one
-- row per (project, role) — admin + member rows can coexist.
CREATE TABLE user_project_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role, project_id)
);

-- ============================================================
-- Kanban Columns
-- ============================================================
-- required_fields: JSON array of fields a task must have populated
--   before entering this column, e.g. '["description","assignee"]'.
--   Emptiness for "description" = TipTap doc with no text-bearing nodes.
--   Emptiness for "assignee" = task_assignees has no rows for this task.
-- github_state: maps this column to a GitHub issue state for sync.
--   Exactly one column per project should map to 'closed' (e.g. Done).
--   Renaming a column never breaks sync — the mapping is explicit.
CREATE TABLE columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,                          -- no UNIQUE: ties are harmless,
                                                             -- and UNIQUE makes reorder painful
  color           TEXT NOT NULL DEFAULT '#6b7280',
  wip_limit       INTEGER,                                   -- NULL = no limit
  required_fields TEXT NOT NULL DEFAULT '[]',
  github_state    TEXT CHECK (github_state IN ('open','closed'))
);

-- ============================================================
-- Swimlanes (horizontal grouping) — milestones + one system Backlog
-- ============================================================
-- kind = 'milestone' (default) | 'backlog'. The Backlog lane is the
-- permanent system lane: created with every project, never archived or
-- deleted, no deadline. Identity is `kind`, not the name — renaming the
-- Backlog lane does not demote it. Partial unique index guarantees at
-- most one backlog lane per project.
-- due_at: YYYY-MM-DD milestone deadline (date-only, no time-of-day).
--   Cross-column CHECK (kind='backlog' AND due_at IS NULL) is NOT in the
--   DDL — SQLite ALTER TABLE cannot add table-level CHECKs; enforced in
--   SwimlaneService (update rejects backlog dueAt → BACKLOG_PROTECTED).
-- archived_at: lane archive cascades to its live tasks (one transaction,
--   per-task `archived` activity rows); restore brings the lane back only.
CREATE TABLE swimlanes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  due_at      TEXT,
  archived_at TEXT,
  kind        TEXT NOT NULL DEFAULT 'milestone'
              CHECK (kind IN ('backlog','milestone'))
);
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';

-- ============================================================
-- Task field options (per-project customizable priority/type)
-- ============================================================
-- Each project owns ordered option lists for the two task fields.
-- tasks.priority / tasks.type are plain TEXT columns (no FK, no CHECK —
-- DEFAULT 'medium' / 'task'); the app validates values against these lists.
-- position: integer ordering; the FIRST option (position 0) is the
--   create default. Delete is blocked while any task uses the option.
CREATE TABLE priority_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);
CREATE INDEX idx_priority_options_project ON priority_options(project_id, position);

CREATE TABLE type_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);
CREATE INDEX idx_type_options_project ON type_options(project_id, position);

-- ============================================================
-- Tasks (the core entity)
-- ============================================================
-- position: fractional-index key (see Design Notes). idx_tasks_position
--   (UNIQUE index on (column_id, position)) turns a
--   concurrent-create race into a constraint violation → app retries
--   with a freshly generated key.
-- GitHub issues are stored in the task_github_issues junction table (multi-issue).
-- The old inline columns (github_issue_id, github_issue_number, github_repo,
--   github_synced_state) still exist on the tasks table but are unused — SQLite's
--   DROP COLUMN (3.35+) could remove them, but they are harmless and left in place.
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id           TEXT NOT NULL REFERENCES columns(id),  -- no ON DELETE clause in DDL;
                                                             -- deleting non-empty column → HasChildren 409
  swimlane_id         TEXT NOT NULL REFERENCES swimlanes(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}', -- TipTap JSON
  priority            TEXT NOT NULL DEFAULT 'medium',        -- label string — no FK
  type                TEXT NOT NULL DEFAULT 'task',          -- label string — no FK
  position            TEXT NOT NULL,                         -- fractional-index key
  archived_at         TEXT,                                   -- NULL = live; set to datetime('now') on archive
                                                              -- archived tasks keep column/position and are excluded
                                                              -- from board/WIP/count queries unless includeArchived
  due_at              TEXT,                                   -- YYYY-MM-DD optional personal deadline; service-enforced
                                                              -- <= lane due_at (DEADLINE_AFTER_LANE when later)
  github_issue_id     TEXT,                                  -- DEPRECATED — now in task_github_issues
  github_issue_number INTEGER,                              -- DEPRECATED
  github_repo         TEXT,                                  -- DEPRECATED
  github_synced_state TEXT CHECK (github_synced_state IN ('open','closed')), -- DEPRECATED
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))   -- maintained by app
);

-- ============================================================
-- Task GitHub Issues (multi-issue junction table)
-- ============================================================
-- One task can be linked to multiple GitHub issues (across repos).
-- synced_state: echo suppression per-link — the webhook handler compares the
--   payload state against this value; equal → skip. Different from column's
--   githubState → outOfSync displayed in UI.
CREATE TABLE task_github_issues (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL,                              -- GitHub node_id
  issue_number  INTEGER NOT NULL,
  repo          TEXT NOT NULL,                              -- "owner/name"
  synced_state  TEXT CHECK (synced_state IN ('open','closed')),
  PRIMARY KEY (task_id, issue_id)
);

-- ============================================================
-- Task Assignees (multi-assignee junction table)
-- ============================================================
-- Replaces the old tasks.assignee TEXT column (single string).
-- Stacked avatars on kanban cards render up to 3 + overflow count.
CREATE TABLE task_assignees (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  PRIMARY KEY (task_id, user_name)
);

-- ============================================================
-- Wiki Pages (nested, TipTap content)
-- ============================================================
-- parent_id ON DELETE RESTRICT: deleting a page with children fails
--   (HasChildren-style 409) — forces explicit move/delete of children.
--   (v1 used SET NULL which silently re-rooted children to top level.)
-- content_text: plain-text projection of `content`, maintained by the app
--   on every write. Backs FTS5 so search indexes real text, not JSON syntax.
CREATE TABLE wiki_pages (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '{}',                   -- TipTap JSON
  content_text TEXT NOT NULL DEFAULT '',                     -- app-maintained plain text
  parent_id    TEXT REFERENCES wiki_pages(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL DEFAULT 0,                   -- ordering within siblings
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

-- FTS5 external-content table for wiki search (MCP search_wiki tool).
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
-- Wiki Page Revisions
-- ============================================================
CREATE TABLE wiki_page_revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL,                              -- TipTap JSON
  content_text TEXT NOT NULL DEFAULT '',                   -- plain text snapshot
  save_type    TEXT NOT NULL CHECK (save_type IN ('autosave', 'manual')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_revisions_page ON wiki_page_revisions(page_id, created_at DESC);

-- ============================================================
-- API Keys (MCP / Hermes auth)
-- ============================================================
-- Raw key format: "lxk_" + base62(32 random bytes) — high entropy by
-- construction, so unsalted SHA-256 of the raw key is a sound storage hash.
-- key_hash UNIQUE also serves as the lookup index.
-- last_used_at: updated only when NULL or older than 1 hour (sampled,
--   avoids a SQLite write on every MCP call).
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                                -- "hermes", "opencode-local"
  key_hash     TEXT NOT NULL UNIQUE,                         -- hex(SHA-256(raw key))
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  user_id      TEXT REFERENCES users(id)                       -- owning user; NULL = unbound key
);

-- ============================================================
-- Webhook event dedup (GitHub delivers at-least-once)
-- ============================================================
-- INSERT OR IGNORE on X-GitHub-Delivery; if a row already exists the
-- event is a duplicate delivery → skip processing.
CREATE TABLE webhook_events (
  delivery_id TEXT PRIMARY KEY,                              -- X-GitHub-Delivery header
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Settings (app key/value store)
-- ============================================================
-- e.g. settings.admin_emails — mirrored from LXK_ADMIN_EMAILS by the
-- setup wizard; read alongside the env var at auth time.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes
-- ============================================================
-- Board fetch = WHERE project_id=? ORDER BY column, position → one index.
CREATE INDEX idx_tasks_board     ON tasks(project_id, column_id, position);
CREATE INDEX idx_tasks_swimlane  ON tasks(project_id, swimlane_id);
CREATE UNIQUE INDEX idx_tasks_position ON tasks(column_id, position);              -- fractional-index integrity
CREATE UNIQUE INDEX idx_task_github_issues_issue ON task_github_issues(issue_id);  -- issue → at most one task
CREATE INDEX idx_columns_project ON columns(project_id, position);
CREATE INDEX idx_swimlanes_proj  ON swimlanes(project_id, position);
CREATE INDEX idx_wiki_project    ON wiki_pages(project_id);
CREATE INDEX idx_wiki_parent     ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_runtimes_machine ON runtimes(machine_id);
CREATE INDEX idx_task_links_from ON task_links(from_task_id);
CREATE INDEX idx_task_links_to   ON task_links(to_task_id);
CREATE INDEX idx_task_links_proj ON task_links(project_id);
-- api_keys.key_hash is indexed by its UNIQUE constraint.

-- ============================================================
-- Forge: runtime agents + persisted document sources
-- ============================================================
-- runtimes: daemons that run agent CLIs (opencode/hermes/command-code) and poll
--   for tasks. model is the agent model id reported by the daemon (FORGE_MODEL);
--   extra_args is server-authoritative injected CLI tokens (JSON array), applied
--   by the daemon at spawn time (Settings → Edit runtime).
--   models_catalog is the live provider/model list the daemon reports with its
--   machine listener heartbeat after each refresh (boot + every ~10 min); []
--   when offline or the agent has no scriptable model list (hermes). Powers
--   the Settings picker. agents_catalog follows the same rule for personas.
-- forge_tasks: the writing-assist queue (created from editors, claimed by a
--   runtime, streamed/completed by the daemon).
-- document_sources: persisted per-document sources (wiki page or external URL)
--   that Forge grounds its output in.
CREATE TABLE runtimes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  model          TEXT NOT NULL DEFAULT '',
  extra_args     TEXT NOT NULL DEFAULT '[]',
  models_catalog TEXT NOT NULL DEFAULT '[]',
  mcp_connected  INTEGER NOT NULL DEFAULT 0,   -- daemon MCP link up (0/1)
  agent          TEXT NOT NULL DEFAULT '',     -- bound agent (rule bundle) id
  print_logs     INTEGER NOT NULL DEFAULT 0,   -- print run logs toggle
  log_level      TEXT NOT NULL DEFAULT '',     -- daemon log verbosity
  agents_catalog TEXT NOT NULL DEFAULT '[]',
  machine_id     TEXT REFERENCES machines(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname       TEXT NOT NULL DEFAULT '',
  last_seen      TEXT,
  last_error     TEXT,                          -- last daemon
                                                 -- failure relayed by the
                                                 -- machine listener (e.g.
                                                 -- "API key revoked", exit 3)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Invariant: a machine hosts at most one runtime per provider (the listener
-- reuses the env on install; remove events are provider-scoped).

-- ============================================================
-- Forge: machine registry + setup events
-- ============================================================
CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL DEFAULT '',
  secret      TEXT NOT NULL DEFAULT '',        -- per-machine binding (0003):
                                              -- minted ONCE at register, returned
                                              -- a single time, required on event
                                              -- claim (x-machine-secret); '' =
                                              -- legacy machine, must re-register
  clis        TEXT NOT NULL DEFAULT '[]',   -- installed agent
                                            -- CLIs reported by the listener
                                            -- heartbeat ([{ provider, version }])
  last_seen   TEXT,                         -- NULL = "bound, not listening"
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_machines_last_seen ON machines(last_seen);
-- Machine lifecycle: lexa-cli login registers (last_seen NULL = bound);
-- machine listen/start heartbeats every 3s (listening); last_seen goes NULL
-- after 2 min without a heartbeat (offline). Machine ids are
-- `hostname-<unique>` for new machines; legacy UUID ids keep working.
-- Delete removes runtimes + pending events (queued remove events first);
-- a still-listening machine reappears on its next heartbeat.

-- Setup events are machine-scoped. Runtime execution settings stay on the
-- runtimes row and are edited from Settings after installation.
CREATE TABLE runtime_events (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  action      TEXT NOT NULL DEFAULT 'install'
                CHECK (action IN ('install', 'update', 'remove')),
  agent_cli   TEXT NOT NULL CHECK (agent_cli IN ('opencode','hermes','command-code')),
  api_key_id  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','completed','failed')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at  TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runtime_events_machine ON runtime_events(machine_id, status);
CREATE INDEX idx_runtime_events_status ON runtime_events(status, created_at);

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
CREATE INDEX idx_forge_tasks_status ON forge_tasks(status, created_at);

-- ============================================================
-- Forge agents + skills — global rule bundles
-- ============================================================
-- Agents are named rule bundles: their instructions become AGENTS.md in the
-- run dir at claim time (claim-carried, no host store). Skills are named
-- operation bundles: their instructions become .agents/<skill>/SKILL.md.
-- Bindings are many-to-many. "Lexa" (the default agent) and the five
-- original assistant actions (continue/rewrite/summarize/expand/grammar)
-- are seeded builtins; builtins are editable + resettable but not deletable.
CREATE TABLE forge_agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_agent_skills (
  agent_id TEXT NOT NULL REFERENCES forge_agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES forge_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE document_sources (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('wiki', 'external')),
  title         TEXT NOT NULL DEFAULT '',
  ref           TEXT NOT NULL,          -- wiki page slug or external URL
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_type, document_id, kind, ref)
);
CREATE INDEX idx_sources_document ON document_sources(document_type, document_id);

-- ============================================================
-- Forge task activity log
-- ============================================================
-- Append-only live status feed per task: the daemon streams lines
-- (claimed by <runtime>, model <id>, agent started, generating,
-- done/failed) so the UI can show what a task is doing right now.
CREATE TABLE forge_task_logs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  stream     TEXT NOT NULL DEFAULT 'out',  -- no CHECK in DDL
  level      TEXT NOT NULL DEFAULT 'info', -- no CHECK in DDL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_forge_task_logs_task ON forge_task_logs(task_id, created_at);
-- Levels are classified ONCE by the daemon at write time (shared/forge-log.ts
-- — stderr ≠ error; retries/rate-limits → warn) and stored; the UI renders
-- the stored level, never re-classifies. Legacy rows default out/info; the UI
-- falls back to the shared classifier for rows still carrying the old
-- [stderr] marker.

-- ============================================================
-- Task links: subtask_of / blocked_by / related_to
-- ============================================================
-- Directed links between tasks. Semantics:
--   subtask_of : from = child, to = parent. Child inherits parent's column;
--                moving a parent cascades to children; deleting a parent with
--                children is blocked (HAS_CHILDREN); cycles are rejected.
--   blocked_by : from = blocked task, to = blocker. Informational only.
--   related_to : symmetric display, stored once (from→to).
CREATE TABLE task_links (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN ('subtask_of', 'blocked_by', 'related_to')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_task_id, to_task_id, relation)
);
CREATE INDEX idx_task_links_from ON task_links(from_task_id);
CREATE INDEX idx_task_links_to   ON task_links(to_task_id);
CREATE INDEX idx_task_links_proj ON task_links(project_id);

-- Task activity timeline + comments (docs/private/specs/ACTIVITY_COMMENTS.md)
-- Append-only by design: rows are never pruned (contrast: webhook_events 7-day).
-- INTEGER PRIMARY KEY: rowid is monotonic — second-granularity created_at ties
-- order by id; UUID text ids would not order chronologically.
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
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);

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
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);
```

## Design Notes

### Task links (subtask / blocked-by / related)
One directed `task_links` table covers all three relations (deliberately reversing
the v1 "cut subtasks" YAGNI — semantics now defined):

- **Subtask placement:** a child's `column_id` equals its parent's. Creating with
  `parentId` inherits the parent's column/swimlane and inserts the `subtask_of`
  link. Moving a parent cascades to children (same column, re-keyed after the
  parent, WIP-bypassed). Cycle guard: a `subtask_of` link whose target is a
  descendant of `from` is rejected (`TASK_LINK_CYCLE`).
- **Blocked-by:** informational — card warning dot + tooltip, listed in detail.
  No move guard.
- **Related-to:** symmetric display, stored once.
- **@-autocomplete:** `GET /projects/:slug/tasks/search?q=` backs the add-link
  dropdown (title LIKE, excludes archived + self, capped at 10).

### Task activity (append-only, never pruned)
`task_activity` is the unified timeline of system events; `task_comments` holds
human (and agent) comments, interleaved in the slideover Activity tab. Both are
append-only — rows are never pruned (deliberate contrast with the 7-day
`webhook_events` prune). Task delete cascades both tables (consistent with the
existing hard delete).

- **Rowid ids:** `INTEGER PRIMARY KEY AUTOINCREMENT`. `created_at` is
  second-granularity, so same-second rows must order by insertion: rowid is
  monotonic and supplies the tiebreak. UUID text ids would not order
  chronologically.
- **Frozen messages:** `message` / `actor_label` (activity) / `author_label` (comments)
  are written once, at event time. Later renames or config changes never
  rewrite history — the row is the record.
- **Actor model:** `actor_kind` ∈ user/agent/system. `actor_user_id` is the
  user row for user actors, the API key owner for agent actors, NULL for
  unbound/system. `actor_label` is the frozen display name.
- **Backfill:** 0004 inserts one `created` row per task existing at migration
  time (from `tasks.created_at`) plus one `archived` row per archived task
  (from `archived_at`). Rows created after the migration get their events from
  the services, not the backfill.
- **Comment edits/deletes** are soft: `edited_at` (UI "edited" marker) and
  `deleted_at` (hidden from timeline). No revision history — edit overwrites
  `body`.

### Forge (runtime agent writing assistant)
Forge is the AI writing button in the task/wiki editors. A **CLI listener** on a
machine registers the machine, claims setup events, owns one daemon child per
installed agent CLI, and reports the machine's available agents/models. Each
daemon registers as a `runtimes` row, polls `forge_tasks`, spawns the configured
CLI in one-shot mode per task, and reports the result.

- **Task lifecycle:** `queued` → (daemon claims) `running` → `completed`/`failed`.
  FIFO claim: the daemon updates the row conditionally (`WHERE status='queued'`);
  a lost race returns null and the daemon polls again.
- **Agents + skills (0027):** every task carries `agent_id` + `skill_id` (global
  rule bundles, M2M bindings). The server resolves them **at claim time** and
  sends the instructions back as `agentMarkdown`/`skillMarkdown`; the daemon
  writes them into the run dir as `AGENTS.md` + `.agents/<skill>/SKILL.md` —
  files-only delivery, no host store, so edits apply to the very next run.
  The prompt itself carries only task context + the output contract (+ the
  per-task `extra_prompt`).
- **Machine state root:** everything the host stores lives in `~/.lexa/`
  (`LEXA_DIR` override): `config.json`, `machine-id`, `env`, `runtimes/<id>/env`,
  and per-run workdirs under `runs/<taskId>/` (ephemeral — removed after every
  run). The listener migrates the legacy `~/.config/lexa-cli` +
  `~/.config/lexa-forge` dirs into it on boot — migrate-and-delete, no fallback.
- **`forge_task_logs`** is the append-only live status feed per task. The daemon
  streams a line per step (claimed, model, agent started, generating, done/failed);
  the UI polls `GET /api/forge/tasks/:id/logs` while a task is active to show
  what it's doing right now.
- **`document_sources`** persist per document (task or wiki page). `kind=wiki`
  stores the wiki page **slug** in `ref`; `kind=external` stores the URL. Forge
  resolves wiki sources to page content server-side; external URLs are fetched
  with an **SSRF guard** (DNS resolve → reject private/loopback/link-local/CGNAT).
- **Setup:** the web wizard sends only machine + agent CLI + a fresh one-time key.
  Provider/model, agent persona, logging, and extra args are edited after setup
  from Settings. The listener discovers catalogs by invoking the installed CLI
  and sends them with the machine heartbeat.
- **Auth:** browser calls use the normal Bearer API key; daemon endpoints
  (`/api/forge/daemon/*`, `/api/forge/runtimes/*`) accept `x-forge-token`
  (`LXK_FORGE_DAEMON_TOKEN`) or a Bearer key.

### Task field options (custom priority/type)
Priority and type are per-project option lists (`priority_options` / `type_options`), not global enums. `tasks.priority` / `tasks.type` are plain TEXT columns (DEFAULT `'medium'` / `'task'`) with **no FK** — SQLite enforces nothing; the service validates the value against the project's option rows (`InvalidOption` 422) and resolves an empty value to the first option.

- **Order** = `position` ascending; the first option (position 0) is the create default.
- **Seeding:** option rows are created by the app — new projects get them at creation (ProjectService). Tasks created through the API resolve an empty priority/type to the project's first option; the literal `'medium'` / `'task'` defaults only apply to rows written outside the service.
- **Delete rule:** an option used by any task cannot be deleted (`OptionInUse` 409). Reassign or delete the tasks first.
- **Validation:** create/update task payloads carry option IDs; services validate the ID belongs to the task's project (`InvalidOption` 422).
- **Dashboard urgency:** `countUrgent` / `findUrgentAcrossAllProjects` use a project's first priority option (position 0) as the "urgent" equivalent. If a team reorders so a different option leads, urgency follows the new default.

### Fractional indexing — use the library, not a hand-rolled scheme
`tasks.position` uses the `fractional-indexing` npm package (Workers-safe, ~2KB). The library exports `generateKeyBetween(a, b)` and `generateNKeysBetween(a, b, n)` only — define wrappers: `generateKeyAfter(x) = generateKeyBetween(x, null)`, `generateKeyBefore(x) = generateKeyBetween(null, x)`.

Key generation is **deterministic** — regenerating with the same inputs yields the same key. Every retry path must therefore RE-READ the anchor rows before regenerating (the concurrent winner's row is now visible). The retry fires only on the `UNIQUE(column_id, position)` violation — never on FK/NOT NULL failures. At most one retry, then surface the error.

- **Create:** read last key in column → `generateKeyAfter(last)` → insert. On position conflict: re-read last, regenerate, insert.
- **Move with neighbors** (`beforeTaskId`/`afterTaskId` given): read both neighbors (validated to be in the TARGET column of the same project) → `generateKeyBetween(before, after)`. Position is always reassigned on move — never carried over from the source column.
- **Move without neighbors** (webhook moves, drop-on-empty-zone): default placement = append to end — read last key in target column → `generateKeyAfter(last)`. **Never** call `generateKeyBetween(null, null)` for a non-empty column: it returns `"a0"`, which collides with the column's first task.
- **Move race safety:** same discipline as create — on position conflict, re-read the anchors (neighbors or last), regenerate, retry once. Create and move share this rule.

### Atomic WIP-limit enforcement
Count-check-then-update is racy. The move is a single conditional statement:

```sql
UPDATE tasks
SET column_id = ?2,
    swimlane_id = ?3,          -- required — every task must belong to a swimlane
    position = ?4,
    updated_at = datetime('now')
WHERE id = ?1
  AND (
    column_id = ?2             -- within-column reorder: count unchanged → skip WIP check
    OR (SELECT COUNT(*) FROM tasks WHERE project_id = ?5 AND column_id = ?2)
       < COALESCE((SELECT wip_limit FROM columns WHERE id = ?2), 9223372036854775807)
  );
```

`rowsChanged = 0` after confirming the task exists → `WipLimitExceeded` (409). Webhook-driven moves use a separate statement without the count clause (robots bypass WIP limits — see LAYERS.md).

- The `column_id = ?2` short-circuit prevents false `WipLimitExceeded` on pure reorders inside an at-limit column (the moving task would otherwise count itself).
- Count and last-key queries include `project_id` so `idx_tasks_board` (leftmost `project_id`) applies.
- Every task must belong to both a column and a swimlane. Columns are templates rendered inside swimlane rows. New projects get a default "Backlog" swimlane.
- **WIP limit is per-column total** — counts ALL tasks in the column across all swimlanes. The WIP badge in each swimlane row shows the same total, not per-swimlane count.

### Echo suppression (`synced_state`)
Every Lexa→GitHub state sync writes the state we pushed to `task_github_issues.synced_state` for that specific issue. The webhook handler compares the payload's issue state against `synced_state`: equal → our own echo → skip. Without this, every move triggers a self-reinforcing webhook storm.

### One task ↔ many issues
Multiple GitHub issues can link to one task. Each link has its own `synced_state` for per-issue echo suppression. The webhook looks up by `issue_id` in `task_github_issues` to find the task.

### FTS5 for `search_wiki`
The `wiki_fts` external-content table + triggers keep the index in sync automatically. The app maintains `content_text` (plain-text projection of TipTap JSON) on every wiki write — searching raw TipTap JSON would match syntax tokens, not words.

### `updated_at` is app-maintained
Every repo `update*` method sets `updated_at = datetime('now')` in the same statement. No triggers — the write path is already centralized in repositories.

### No multi-statement ACID needed
Every mutation is either a single statement or a SQLite transaction (`server/db/database.ts` `batch()` helper — `db.transaction()` wrapping prepared statements, atomic all-or-nothing). The one multi-write flow (move + update synced state) runs through `batch()`.

### SQLite notes (unchanged from v1)
- TEXT UUIDs via `crypto.randomUUID()` in Bun.
- SQLite is local (WAL) — reads are immediate. Frontend still updates its cache from mutation responses (TanStack Query `setQueryData`), not refetch, because the mutation response is the authoritative state.
- No row-size limits at this scale: fine for TipTap docs.
- `webhook_events` grows unboundedly → periodic prune (`DELETE WHERE received_at < datetime('now','-7 days')`) on a timer or at boot.

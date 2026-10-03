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
  key         TEXT,                                          -- ticket-key prefix (e.g. "NIM"); UNIQUE, nullable — backfilled at boot
  next_task_number INTEGER NOT NULL DEFAULT 0,               -- per-project ticket counter (monotonic, never reused)
  description TEXT NOT NULL DEFAULT '',
  team_id     TEXT REFERENCES organization(id) ON DELETE SET NULL,  -- owning team; NULL = unassigned, superadmin-only until assigned
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))        -- maintained by app on every UPDATE
);
CREATE INDEX idx_projects_team ON projects(team_id);
CREATE UNIQUE INDEX idx_projects_key ON projects(key);

-- ============================================================
-- Project GitHub repos (roles per repo)
-- ============================================================
-- Replaces the dropped projects.github_repo column. A project links N repos,
-- each with independent role flags (a repo can be source, workspace, or both):
--   source_role    → Assistant repo-content grounding (per-run Context: Read) + project label
--   workspace_role → issue linking/creation/sync for that repo
-- Removing a role gates NEW links only — existing task↔issue links keep syncing.
-- Migrated at boot: legacy projects.github_repo → both roles; repos seen in
-- task_github_issues → workspace role.
CREATE TABLE project_repos (
  id              TEXT PRIMARY KEY,                          -- UUID
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,                             -- "owner/name"
  source_role     INTEGER NOT NULL DEFAULT 0,                -- Assistant grounding + project label
  workspace_role  INTEGER NOT NULL DEFAULT 0,                -- issue link/create/sync
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_project_repos_unique ON project_repos(project_id, repo);
CREATE INDEX idx_project_repos_repo ON project_repos(repo);

-- ============================================================
-- Users + project roles
-- ============================================================
-- Humans authenticate in-app (Better Auth, email/password) — no Cloudflare
-- Access, no edge identity. users.id is re-keyed to the Better Auth id
-- format (32 lowercase hex chars via lower(hex(randomblob(16)))) by the
-- auth migration; FK references
-- (user_project_roles.user_id, api_keys.user_id, comments.author_id,
-- activity.actor_user_id) are rewritten to the new ids. The global role
-- comes from the env allow-list LXK_ADMIN_EMAILS (applied at provisioning
-- via the setup wizard only) — never edited at runtime; legacy 'admin'
-- values migrated to 'superadmin'; the admin_emails setting is DELETED.
-- Team-admin authority comes from the org member role (owner/admin), never
-- from users.role. email_verified backfilled 1 for all legacy users.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,                            -- Better Auth id (lower(hex(randomblob(16))) = 32 lowercase hex chars)
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('superadmin', 'member')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen      TEXT,
  email_verified INTEGER NOT NULL DEFAULT 1,                  -- legacy rows backfilled 1
  image          TEXT,                                        -- avatar (unused by default email/password)
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- admin plugin (R16 user lifecycle: ban = deactivate) — camelCase columns,
  -- the plugin queries them verbatim
  banned         INTEGER NOT NULL DEFAULT 0,
  banReason      TEXT,
  banExpires     TEXT
);

-- Per-project roles. One row per (user, project): PRIMARY KEY
-- (user_id, role, project_id) plus UNIQUE INDEX ux_user_project_roles_user_project
-- (user_id, project_id), added in 0018.
CREATE TABLE user_project_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role, project_id)
);

-- ============================================================
-- Better Auth tables (auth-roles-teams) — library-owned shapes
-- ============================================================
-- Email/password sessions, accounts, and verification tokens (set-password
-- links, invite acceptance). Timestamps are TEXT — the kysely adapter
-- serializes Date as ISO 8601 strings (spike-verified), unlike Lexa's
-- TEXT datetime('now') conventions.
-- No social providers: account.providerId is always 'credential'.
CREATE TABLE session (
  id                    TEXT PRIMARY KEY,
  expiresAt             TEXT NOT NULL,                        -- ISO 8601; 7d sliding (updateAge 24h)
  token                 TEXT NOT NULL UNIQUE,                 -- session token (hashed)
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL,
  ipAddress             TEXT,
  userAgent             TEXT,
  userId                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activeOrganizationId  TEXT,                                 -- organization plugin; NULL = no active team
  impersonatedBy        TEXT                                  -- admin plugin (better-auth 1.7+); NULL = no impersonation
);
CREATE INDEX session_userId_idx ON session(userId);

CREATE TABLE account (
  id                    TEXT PRIMARY KEY,
  accountId             TEXT NOT NULL,                        -- = user id for credentials
  providerId            TEXT NOT NULL,                        -- 'credential' only
  userId                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  password              TEXT,                                 -- Better Auth scrypt hash
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL
);
CREATE INDEX account_userId_idx ON account(userId);

CREATE TABLE verification (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,                                  -- set-password / invite token id
  value       TEXT NOT NULL,                                  -- the secret value
  expiresAt   TEXT NOT NULL,                                  -- ISO 8601; 7d
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

-- ============================================================
-- Teams (Better Auth organizations) + membership
-- ============================================================
-- A team = an organization row; slug unique. Team-admin authority = the
-- member row's org role (owner/admin) — independent per (team, user);
-- users.role stays the global axis only (superadmin|member).
CREATE TABLE organization (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,                            -- duplicate → SlugTaken 409
  logo       TEXT,
  createdAt  TEXT NOT NULL,                                   -- ISO 8601 (Better Auth)
  metadata   TEXT
);

CREATE TABLE member (
  id             TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,                               -- 'owner'|'admin'|'member' (comma-joined as Better Auth writes it)
  createdAt      TEXT NOT NULL,                               -- ISO 8601 (Better Auth)
  UNIQUE(organizationId, userId)                              -- one row per (team, user); N teams = N rows
);
CREATE INDEX member_organizationId_idx ON member(organizationId);
CREATE INDEX member_userId_idx ON member(userId);

-- Organization invitations (better-auth 1.7+ startup check mandates the
-- table; Lexa never uses it — team membership is direct member-row
-- insertion, no email invites at team level).
CREATE TABLE invitation (
  id             TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',             -- pending|accepted|rejected|canceled
  teamId         TEXT,                                         -- org-teams feature (unused)
  inviterId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt      TEXT NOT NULL,
  createdAt      TEXT NOT NULL
);
CREATE INDEX invitation_organizationId_idx ON invitation(organizationId);
CREATE INDEX invitation_email_idx ON invitation(email);

-- ============================================================
-- Workspace invitations (superadmin-issued app-member invites)
-- ============================================================
-- Link-based (no email transport): token = link secret, expires 7d after
-- issue, revocable while pending. Accepted on first login — the invitee
-- sets their own password → member account created → accepted_at stamped.
-- Lexa conventions (TEXT datetime('now')) — unlike the Better Auth tables.
CREATE TABLE workspace_invitations (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member',                 -- 'member' only (superadmin-issued app-member invites)
  token       TEXT NOT NULL UNIQUE,                           -- link secret (crypto.randomUUID())
  expires_at  TEXT NOT NULL,                                  -- 7d after issue
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,   -- superadmin who issued
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT                                           -- NULL = pending
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
-- is_done: explicit done marker — independent of github_state. Multiple
--   done columns per project are allowed (e.g. Done + Released). Progress
--   (sprint X/Y) counts a task as done when it sits in a done column OR is
--   archived — derived at read time, never stored.
CREATE TABLE columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,                          -- no UNIQUE: ties are harmless,
                                                             -- and UNIQUE makes reorder painful
  color           TEXT NOT NULL DEFAULT '#6b7280',
  wip_limit       INTEGER,                                   -- NULL = no limit
  required_fields TEXT NOT NULL DEFAULT '[]',
  github_state    TEXT CHECK (github_state IN ('open','closed')),
  is_done         INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- Milestones (goal wrapper above sprints)
-- ============================================================
-- A milestone is a goal wrapper (e.g. "v1.0 launch") holding one or more
-- sprints via swimlanes.milestone_id. Plain wrapper — no kind, no system
-- lanes. due_at is the target date (YYYY-MM-DD, date-only); NULL = no
-- deadline. Deleting a milestone with sprints is blocked (HAS_CHILDREN
-- 409, details { count }) — sprints must be loosened/reassigned first;
-- ON DELETE SET NULL on swimlanes.milestone_id is the safety net for
-- direct DB writes only. Archive cascade (milestone → its sprints → their
-- live tasks) is service-level, one atomic set-based batch, per-task
-- `archived` activity rows; restore brings the milestone back only.
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

-- ============================================================
-- Swimlanes (horizontal grouping) — sprints + one system Backlog
-- ============================================================
-- kind = 'sprint' (default) | 'backlog'. Every non-backlog lane is a
-- sprint: time-boxed (start_at → due_at) and optionally belonging to a
-- milestone (milestone_id); NULL milestone_id = loose sprint. The Backlog
-- lane is the permanent system lane: created with every project, never
-- archived or deleted, no dates, never in a milestone. Identity is `kind`,
-- not the name — renaming the Backlog lane does not demote it. Partial
-- unique index guarantees at most one backlog lane per project.
-- due_at: YYYY-MM-DD sprint deadline (date-only). start_at: YYYY-MM-DD
--   sprint start; NULL = unset (a due-only sprint renders as a ◆ marker on
--   the timeline until start_at is set).
-- milestone_id: FK to milestones(id) ON DELETE SET NULL — deleting a
--   milestone loosens its sprints (they surface as "No milestone" sprints).
-- Cross-column CHECKs (kind='backlog' AND due_at/start_at/milestone_id
--   IS NULL; start_at <= due_at) are NOT in the DDL — SQLite ALTER TABLE
--   cannot add table-level CHECKs; enforced in SwimlaneService (backlog
--   rejects dueAt/startAt/milestoneId → BACKLOG_PROTECTED; start_at later
--   than due_at → INVALID_ARGS).
-- The squashed 0001_init.sql baseline carries this table with the sprint
--   CHECKs already applied (the pre-squash create-new / copy / drop / rename
--   rebuild is folded in): legacy 'milestone' rows are loose sprints
--   (kind 'sprint', milestone_id NULL); due_at survived.
-- archived_at: lane archive cascades to its live tasks (one atomic
--   set-based batch, per-task `archived` activity rows); restore brings
--   the lane back only.
CREATE TABLE swimlanes (
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
  key                 TEXT,                                  -- ticket key "PREFIX-n" (e.g. "NIM-12"); nullable — backfilled at boot
  number              INTEGER,                               -- per-project ticket number; UNIQUE(project_id, number) — never reused
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
CREATE UNIQUE INDEX idx_tasks_project_number ON tasks(project_id, number);

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
  issue_title   TEXT,                                       -- last-known upstream GitHub title (NULL = unknown)
  pushed_title  TEXT,                                       -- last title we pushed (webhook echo detection)
  pushed_body   TEXT,                                       -- last body we pushed (Markdown)
  push_failed   INTEGER NOT NULL DEFAULT 0,                 -- last content push failed (badge reason)
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
-- Attachments (per-project rows over content-addressed blobs)
-- ============================================================
-- Rows are per-project: UNIQUE(project_id, sha256) dedupes re-uploads of the
-- same bytes within one project (a dedupe hit returns the existing row
-- unchanged — no second activity row, no blob rewrite). The blob itself is
-- content-addressed GLOBALLY by sha256 (storage_key = "blobs/<sha256>"), so
-- identical files across projects share one stored object; the blob is
-- deleted when the last referencing row goes.
-- Insert-only row — no updated_at (task_github_issues precedent).
-- Exactly one of task_id / wiki_page_id is set (CHECK); task attachments emit
-- attachment_added / attachment_removed activity rows in the same transaction
-- as the mutation; wiki-page uploads emit nothing (wiki has no timeline).
-- mime_type is SERVER-SNIFFED at upload (magic bytes) — the client-declared
-- content type is never trusted or stored.
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

-- 0015_chat_attachments.sql — chat attachments are TEMPORARY conversation
-- context, NOT project artifacts. Deliberately a separate table from
-- `attachments`: no UNIQUE(project_id, sha256) dedupe (per-thread rows),
-- no task_activity emission, never listed on a project's attachment surface.
-- Thread-scoped lifecycle: the composite FK (document_type, document_id) →
-- assistant_threads(document_type, document_id) with ON DELETE CASCADE means
-- the row dies with its conversation. `mime_type` is SERVER-SNIFFED at upload
-- (magic bytes; content with no signature is UTF-8-probed and extension-
-- classified) — the client-declared content type is never trusted or stored.
-- `storage_key` stays content-addressed ("blobs/<sha256>"), so a blob shared
-- with a task/wiki attachment is deleted only when the LAST referencing row
-- across BOTH tables goes. Additive only — `attachments` is never rebuilt.
CREATE TABLE chat_attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_type, document_id) REFERENCES assistant_threads(document_type, document_id) ON DELETE CASCADE
);
CREATE INDEX idx_chat_attachments_thread ON chat_attachments(document_type, document_id);
CREATE INDEX idx_chat_attachments_storage_key ON chat_attachments(storage_key);
CREATE INDEX idx_chat_attachments_project ON chat_attachments(project_id);

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
  updated_by   TEXT,                                         -- users.id of the last save; NULL for legacy rows
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

-- FTS5 external-content table for wiki search.
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
-- Wiki Share Links (public, revocable read links)
-- ============================================================
-- token = capability: random base64url, stored plaintext, UNIQUE (the UNIQUE
--   index doubles as the public lookup index). The API returns the full URL
--   once at create; the raw token is never sent again afterwards.
-- expires_at: UTC ISO-8601 or NULL (= never expires), compared lexically
--   server-side. Revocation is row deletion; deleting a page cascades its
--   links. Public reads resolve the descendant tree at request time, and
--   missing/expired/revoked links are indistinguishable externally.
CREATE TABLE wiki_share_links (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT,
  created_by  TEXT REFERENCES users(id),                       -- NULL = created via unbound admin API key
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wiki_share_links_page ON wiki_share_links(page_id);

-- ============================================================
-- API Keys (machine auth)
-- ============================================================
-- Raw key format: "lxk_" + base62(32 random bytes) — high entropy by
-- construction, so unsalted SHA-256 of the raw key is a sound storage hash.
-- key_hash UNIQUE also serves as the lookup index.
-- last_used_at: updated only when NULL or older than 1 hour (sampled,
--   avoids a SQLite write on every API call).
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                                -- "hermes", "opencode-local", "cli-<hostname>"
  key_hash     TEXT NOT NULL UNIQUE,                         -- hex(SHA-256(raw key))
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  user_id      TEXT REFERENCES users(id)                       -- owning user; NULL = server key
);
-- Ownership semantics: UI-created keys are ALWAYS user-bound (user_id =
-- creator). user_id NULL = "server key" — legacy/dev rows only;
-- never created through the UI. Server keys resolve to
-- role admin; bound keys resolve to the owner's role (superadmin→admin,
-- member→member) and the owner's project access. Bound keys are revoked
-- explicitly when the user is removed (workspace deletion), never cascaded.

-- ============================================================
-- Device login requests (CLI pairing flow)
-- ============================================================
-- Pairing flow: the CLI creates a request and prints a verify URL
-- carrying a 256-bit random token (stored hashed — token_hash UNIQUE
-- doubles as the lookup index, same pattern as api_keys.key_hash). A
-- logged-in user opens the URL and approves (session + token = both
-- required); approve records the approver only. The CLI's first poll
-- after approval atomically consumes the row and mints a USER-BOUND API
-- key (user_id = approver), returning the raw key ONCE — replay
-- impossible. No in-memory transit store. Expired rows are purged at boot.
CREATE TABLE device_login_requests (
  id               TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,          -- hex(SHA-256(token)); lookup = poll/approve
  code             TEXT NOT NULL,                 -- short display code (8 chars)
  client_name      TEXT NOT NULL,                 -- "cli-<hostname>"
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  expires_at       TEXT NOT NULL,                 -- datetime('now', '+10 minutes'); compared lexically
  approver_user_id TEXT REFERENCES users(id),     -- set at approve
  api_key_id       TEXT REFERENCES api_keys(id) ON DELETE SET NULL,  -- legacy/unused (old rows only)
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
-- The legacy admin_emails key is DELETED (row + code + UI) — the env
-- allow-list LXK_ADMIN_EMAILS is the only superadmin source, applied at
-- provisioning only, never edited at runtime.
-- settings.rate_limit_max / settings.rate_limit_window_ms — per-IP rate limit,
-- read by the API middleware (DB is the single source; code defaults as
-- fallback).
-- settings.github_app_id / github_app_slug — plaintext GitHub App identifiers,
-- read by the GitHub client and shown in Settings.
-- settings.github_private_key / github_webhook_secret — LEGACY plaintext
-- credential rows, kept readable as a fallback only. New secrets are written
-- ENCRYPTED to github_app_secrets (0017); an encrypted row, when present, is
-- authoritative (see Design Notes → Managed secrets).
-- Env (LXK_RATE_LIMIT_*) is a FIRST-BOOT BOOTSTRAP: mirrorSettingsFromEnv
-- imports it into these keys once at boot when they are empty; the runtime
-- never reads env again. GitHub config is DB-only, never env.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0017_github_app_secrets.sql — GitHub App credentials move into the encrypted
-- secrets store. Numbering: 0016 is reserved for the future
-- `0016_drop_provider_api_key.sql` (Release N+1), so this migration takes the
-- next free number; the runner applies migrations by filename order. One row
-- per credential name ('private_key' | 'webhook_secret'); the envelope columns
-- mirror the other per-scope secret tables. Scope "github", frozen AAD prefix
-- "lexa-github-v1", AAD-bound to the row name. No FK, no plaintext column.
-- Legacy plaintext `settings.github_private_key` / `github_webhook_secret` rows
-- are NOT migrated — they stay readable as a fallback.
CREATE TABLE github_app_secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
CREATE INDEX idx_swimlanes_milestone ON swimlanes(project_id, milestone_id, position);
CREATE INDEX idx_wiki_project    ON wiki_pages(project_id);
CREATE INDEX idx_wiki_parent     ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_task_links_from ON task_links(from_task_id);
CREATE INDEX idx_task_links_to   ON task_links(to_task_id);
CREATE INDEX idx_task_links_proj ON task_links(project_id);
-- api_keys.key_hash is indexed by its UNIQUE constraint.

-- ============================================================
-- Assistant (Cloudflare Workers only — ADR-0003)
-- ============================================================
-- Every `assistant_*` table below stays in the shared, flavor-agnostic
-- migration set (Docker keeps them inert; D1 cannot drop columns cheaply).
-- On Workers the assistant runs on `@cloudflare/ai-chat` Durable Objects: DO
-- SQLite is the CANONICAL message store (replay/resume/recovery), and the D1
-- `assistant_threads` row is a per-step MIRROR (list/search/export may lag by
-- one mirror write). The Bun/Docker flavor serves no assistant routes and
-- reports `assistant:false` from `/api/capabilities`.
-- ============================================================
-- Assistant task queue (document Generate)
-- ============================================================
-- assistant_tasks: the document-Generate queue. Rows are created from the
-- editor popover, enqueued into the per-thread DO (`enqueueRun`), and completed
-- there; status/terminal transitions are written back through the Worker
-- internal route. No daemon/machine columns — the assistant runs in a
-- per-thread Durable Object (Workers only; renamed from runtime_tasks by
-- 0008_remove_agent_runtimes.sql).
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
CREATE INDEX idx_assistant_tasks_created ON assistant_tasks(created_at DESC, id DESC);
CREATE INDEX idx_assistant_tasks_status ON assistant_tasks(status, created_at);

-- ============================================================
-- Assistant agents + skills — global rule bundles
-- ============================================================
-- Agents are named rule bundles: their instructions become AGENTS.md in the
-- run dir at claim time (claim-carried, no host store). Skills are named
-- operation bundles: their instructions become .agents/<skill>/SKILL.md.
-- Bindings are many-to-many. "Lexa" (the default agent) and the five
-- original assistant actions (continue/rewrite/summarize/expand/grammar)
-- are seeded builtins; builtins are editable + resettable but not deletable.
-- Renamed from forge_* in the squashed 0001_init.sql baseline — column
-- definitions unchanged.
-- Exactly ONE builtin agent — 'assistant' ("Assistant Agent", PM-assistant
-- persona). The generic 'lexa' entry and the blacksmith coding agent are
-- retired (blacksmith removed by 0008_remove_agent_runtimes.sql). The
-- assistant id was seeded as 'hearth-herald' in the 0001 baseline, rebound to
-- 'herald' by 0005_runtime_rename.sql, and rebound to 'assistant' by
-- 0006_assistant_rename.sql. Skill
-- availability per agent = lexa_agent_skills junction rows ONLY (no JSON
-- columns); builtins are editable + resettable but not deletable.
CREATE TABLE lexa_agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lexa_skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lexa_agent_skills (
  agent_id TEXT NOT NULL REFERENCES lexa_agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES lexa_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

-- ============================================================
-- Assistant assistant tier + Gateway (baked into the 0001_init.sql baseline)
-- ============================================================
-- Per-project Assistant settings. The baseline hard-recreated this table
-- dropping legacy provider columns (kind, base_url, api_key, model, vision_model);
-- 0008_remove_agent_runtimes.sql dropped engine + engine_switcher_enabled.
-- Remaining columns: search + reasoning + write_tools, plus
-- fallback_model_ids (JSON array of assistant_models ids, ordered, ≤3) and
-- provider_id + primary_model_id (primary binding to assistant_providers/models).
CREATE TABLE assistant_settings (
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

-- Assistant Gateway: global providers (no project_id) — superadmin-only.
-- `api_key` is a DEAD column in Release N: it stays NOT NULL, every write stores
-- '' (the empty string), and only the one-way boot backfill reads it. Release N+1
-- drops it (migration 0016). The live credential is `assistant_provider_secrets`.
CREATE TABLE assistant_providers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistant_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES assistant_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses','workers_ai')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assistant_models_provider ON assistant_models(provider_id);
CREATE UNIQUE INDEX idx_assistant_models_provider_priority ON assistant_models(provider_id, priority);

CREATE TABLE assistant_call_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES assistant_providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible','openai_responses','workers_ai')),
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
CREATE INDEX idx_call_logs_project_time ON assistant_call_logs(project_id, created_at);
CREATE INDEX idx_call_logs_provider ON assistant_call_logs(provider_id);
CREATE INDEX idx_call_logs_model ON assistant_call_logs(model);

CREATE TABLE assistant_model_prices (
  model TEXT PRIMARY KEY,
  prompt_price REAL NOT NULL DEFAULT 0,       -- USD per 1M input tokens
  completion_price REAL NOT NULL DEFAULT 0,   -- USD per 1M output tokens
  cached_read_price REAL NOT NULL DEFAULT 0,  -- USD per 1M cached-input tokens
  cached_write_price REAL NOT NULL DEFAULT 0, -- USD per 1M cache-write tokens
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistant_provider_health (
  provider_id TEXT PRIMARY KEY REFERENCES assistant_providers(id) ON DELETE CASCADE,
  failure_count INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('open','closed','half-open')) DEFAULT 'closed',
  opened_at TEXT,
  last_probe_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Agent catalog (baked into the 0001_init.sql baseline; the ids are rebound
-- once more by 0005_runtime_rename.sql). Exactly one builtin — 'assistant'
-- ("Assistant Agent", PM-assistant persona). The generic 'lexa' entry and the
-- blacksmith coding agent are retired; blacksmith's row + junction rows are
-- deleted by 0008_remove_agent_runtimes.sql.
-- The pre-squash rebind was atomic (agent-id FKs + junction rows in one tx); its
-- one-time consequence was that existing threads keyed on the old agentId saw
-- an unknown agent and started fresh.
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin)
VALUES ('assistant', 'Assistant Agent', <companion-persona description>, <companion-persona instructions>, 1);
-- Junction seeding: Assistant Agent gets every builtin skill.
INSERT INTO lexa_agent_skills (agent_id, skill_id)
SELECT 'assistant', id FROM lexa_skills WHERE is_builtin = 1;

-- Assistant thread transcripts: one persisted conversation per document
-- (ModelMessage[] JSON in `messages`). Long threads roll into `summary`
-- (`summarized_count` = messages folded into it) — explicit replacement for
-- opencode's auto-compaction. document_type 'chat' rows are keyed by a chat
-- id and scoped to `owner_user_id`.
--
-- Workers-only storage role (ADR-0003): this D1 row is a MIRROR of the
-- canonical DO SQLite store — the per-thread Durable Object is authoritative
-- for replay/resume/recovery and writes this row per persisted step. List,
-- search, and export read the mirror and may lag by one mirror write; the
-- canonical transcript read goes to the DO with a D1 fallback. On Bun/Docker
-- the table is inert (the flavor serves no assistant routes).
--
-- Multi-thread chat: chat rows are N-per-(project_id, owner_user_id), each
-- keyed by its own chat id. `title` is the list label — derived once from the
-- first text message (CRLF→space, whitespace collapsed, ≤60 chars) or set by
-- rename; saves backfill with COALESCE so a rename survives later writes.
-- Backfill caveat: a first message that is an image-ref array has no text
-- content, so its title stays NULL until the next send derives it.
-- `pinned` pins a thread to the top of the owner's list (pinned DESC, then
-- updated_at DESC). Per-turn metadata (user `ts`, assistant `ts`/`citations`/
-- `error`/`stopped`) lives INLINE in the messages JSON — no meta table, no
-- migration churn when the meta shape evolves.
-- DEPRECATED: `skill_id` is no longer written for chat threads — skills are
-- invoked per message with `$name` (junction-bound) and discovered via the
-- `get_skill` tool, never bound to the thread. The column stays nullable and
-- is dropped in a later migration.
CREATE TABLE assistant_threads (
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  title TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  skill_id TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_type, document_id)
);
CREATE INDEX idx_assistant_threads_chat_list ON assistant_threads(project_id, owner_user_id, pinned DESC, updated_at DESC)
  WHERE document_type = 'chat';

-- Assistant write tools v2 (in the 0001_init.sql baseline): per-write approval queue. Write-tool proposals
-- persist here at proposal time; the owner approves or rejects each row; resume
-- executes approved rows in seq order. TTL is lazy (flipped to 'expired' on
-- decide/resume/transcript reads) — no timer.
--
-- Lifecycle: status starts 'pending'; decideApproval moves it to
-- 'approved'/'rejected' via a conditional UPDATE (WHERE status='pending'
-- RETURNING * — second decisions return null, a guard not an error); rows past
-- expires_at flip to 'expired' lazily via expireIfDue/sweepExpired. Resume
-- refuses while any row in the batch is still pending (APPROVALS_PENDING),
-- executes approved rows in seq order, and records per-row failures in
-- execution_error ('CODE: message') without aborting the batch.
--
-- Attribution: executed writes run as the assistant actor with the pending row's
-- owner_user_id; task_activity/task_comments rows written by an approved write
-- carry via_assistant=1 so the timeline can mark them as Assistant-proposed,
-- owner-approved actions.
CREATE TABLE assistant_pending_writes (
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
  FOREIGN KEY (document_type, document_id) REFERENCES assistant_threads(document_type, document_id) ON DELETE CASCADE
);
CREATE INDEX idx_assistant_pending_batch ON assistant_pending_writes(batch_id, seq);
CREATE INDEX idx_assistant_pending_thread ON assistant_pending_writes(document_type, document_id, status);

ALTER TABLE task_activity ADD COLUMN via_assistant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_comments ADD COLUMN via_assistant INTEGER NOT NULL DEFAULT 0;
-- write_tools is baked into the 0001_init.sql baseline (assistant_settings rebuild).

-- Assistant MCP server registry (0009_assistant_mcp.sql). Global registry
-- (superadmin-managed) + per-project availability junction; a project's absent
-- row means the server is unavailable there. The registry holds REMOTE MCP
-- clients only — http/sse, which carry a url and no command. `command`/`args`
-- and the stdio arm of the CHECK are the retained 0009 shape: D1 supports
-- neither DROP COLUMN nor a CHECK rewrite, and 0010 empties the stdio rows
-- instead of rebuilding the table (see below). `secret_ref` is a **legacy**
-- column: it once held an 'env:NAME' | 'file:/abs/path' reference, but managed
-- envelope-encrypted tokens became the only credential source (2026-09-28),
-- migration `0012_remove_mcp_secret_refs.sql` clears every stored value, and
-- the repo never writes it again (any write nulls it). The repo's public mapper
-- ignores it and exposes `hasSecret` + `secretSource` instead. A managed token
-- is never stored here at all: it lives encrypted in `assistant_mcp_secrets`
-- (0011).
CREATE TABLE assistant_mcp_servers (
  id TEXT PRIMARY KEY,                                  -- stable slug, e.g. 'jev'
  label TEXT NOT NULL,
  transport_type TEXT NOT NULL CHECK (transport_type IN ('http','sse','stdio')),
  url TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',                      -- JSON array of strings
  secret_ref TEXT,                                      -- legacy; cleared by 0012, never written again
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (transport_type IN ('http','sse') AND url IS NOT NULL AND command IS NULL)
    OR (transport_type = 'stdio' AND command IS NOT NULL AND url IS NULL)
  )
);

CREATE TABLE assistant_mcp_project_servers (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES assistant_mcp_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, server_id)
);

-- 0009 seeded a disabled stdio 'jev' row (the `jev-mcp` binary on the Lexa
-- host, impossible on Cloudflare Workers). 0010_remove_stdio_mcp_clients.sql
-- deletes that row together with every other stdio row and its project
-- bindings, so a current database has no stdio registrations. This DDL block
-- above is the 0009 baseline and is kept for historical reference.

-- 0011: managed MCP client secrets (envelope encryption).
--
-- A client credential entered in the webapp is stored here as AES-256-GCM
-- ciphertext; the master key never leaves the environment
-- (LXK_SECRETS_MASTER_KEY, with LXK_SECRETS_MASTER_KEY_PREV as the rotation read
-- path). `key_id` records the keyring SLOT the blob was encrypted under
-- ('active' | 'prev') — never a fingerprint, counter, or date — so a rotation
-- keeps existing rows readable through the PREV slot and needs no rewrap.
--
-- New table only: no ALTER, no rebuild, no data movement, so it is safe on
-- both runners. Ciphertext is kept out of assistant_mcp_servers on purpose —
-- a `SELECT *` of the registry can never surface a blob, and the registry
-- reads the secret through a LEFT JOIN (absence of a row = no managed token).
--
-- The FK cascades under the Workers/D1 runner, but the Bun runner executes
-- with `PRAGMA foreign_keys = OFF` (server/db/migrate.ts), where the cascade
-- never fires — so repo.remove deletes this row explicitly instead of relying
-- on the parent DELETE alone (same lesson as 0010).

CREATE TABLE assistant_mcp_secrets (
  server_id TEXT PRIMARY KEY REFERENCES assistant_mcp_servers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,                                -- base64, AES-256-GCM (ciphertext||128-bit tag)
  iv TEXT NOT NULL,                                        -- base64, 12 random bytes per write
  key_id TEXT NOT NULL,                                    -- 'active' | 'prev' — the keyring slot
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0012_remove_mcp_secret_refs.sql — managed-only MCP client secrets
-- (maintainer decision 2026-09-28). The `env:`/`file:` reference source is
-- removed end to end; managed tokens are the ONLY credential source and
-- secret-less clients remain legal. Every stored `secret_ref` value is dead and
-- cleared by this single UPDATE (verbatim). The column is NOT dropped — D1
-- cannot drop/rebuild a column safely — so it stays legacy and is never written
-- again (the repo nulls it on every write). Ciphertext rows are untouched, so a
-- managed token stays usable across the migration.
UPDATE assistant_mcp_servers SET secret_ref = NULL WHERE secret_ref IS NOT NULL;

-- 0013_jev_registry.sql — Jev (Typesafe System 1) moves out of env into a DB
-- registry. New tables only: no ALTER, no rebuild, no data movement.
--
-- Jev's three historical env keys are deleted; base URL + model become config
-- columns and the API key is stored as
-- AES-256-GCM ciphertext in `assistant_jev_secrets` under the shared secrets
-- keyring (LXK_SECRETS_MASTER_KEY), scoped 'jev' and AAD-bound to the config row.
-- `assistant_jev_projects` is opt-in per project. `INSERT OR IGNORE` seeds the
-- singleton so `getConfig`'s LEFT JOIN always has a row to hang a secret on.
CREATE TABLE assistant_jev_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  base_url TEXT NOT NULL DEFAULT 'https://api.typesafe.ai',
  model TEXT NOT NULL DEFAULT 'jev-latest',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO assistant_jev_config (id) VALUES ('default');

CREATE TABLE assistant_jev_secrets (
  config_id TEXT PRIMARY KEY REFERENCES assistant_jev_config(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,   -- base64, AES-256-GCM (ciphertext||128-bit tag)
  iv TEXT NOT NULL,           -- base64, 12 random bytes per write
  key_id TEXT NOT NULL,       -- 'active' | 'prev' — the keyring slot
  key_hint TEXT NOT NULL,     -- last 4 chars of the entered key, display only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistant_jev_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0014_provider_secrets.sql — LLM provider credentials move from the plaintext
-- `assistant_providers.api_key` column into envelope-encrypted rows. New table
-- only (no ALTER, no rebuild).
--
-- Release N ships this file plus the one-way boot backfill
-- (server/db/provider-secrets-backfill.ts), which encrypts every non-empty
-- `api_key` into this table and then writes '' (the column is NOT NULL). All
-- writes store '' from here on; only the backfill reads the legacy column. The
-- live credential is scoped 'provider' and AAD-bound to the provider id.
CREATE TABLE assistant_provider_secrets (
  provider_id TEXT PRIMARY KEY REFERENCES assistant_providers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Curated project memory: judgment-type facts only (live truth always comes
-- from DB reads, never memorized). `source` ∈ manual/assistant (no CHECK in DDL).
-- FTS5 external-content index below; kept in sync by the repo on
-- insert/delete (no triggers).
CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE project_memory_fts USING fts5(content, content='project_memory', content_rowid='rowid');

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

-- Task activity timeline + comments
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

-- Migration bookkeeping (server/db/migrate.ts):
-- _migrations (name TEXT PRIMARY KEY, applied_at TEXT) — applied migration files.
-- The pre-release chain (0001-0024) was squashed into the single 0001_init.sql
-- baseline for 2026.1.0. Migrations after the baseline are additive:
-- 0002_device_login.sql, 0003_herald_prices_1m_cached.sql, 0004_ui_gaps_w4.sql,
-- 0005_runtime_rename.sql (Hearth→Runtimes), 0006_assistant_rename.sql
-- (Herald→Assistant), 0007_runtimes_team_restrict.sql (runtimes.team_id →
-- RESTRICT), 0008_remove_agent_runtimes.sql (drops the runtime tier; rebuilds
-- runtime_tasks → assistant_tasks and assistant_settings without the engine
-- columns), 0009_assistant_mcp.sql (assistant MCP client registry),
-- 0010_remove_stdio_mcp_clients.sql (deletes every stdio registration and its
-- project bindings — junction rows first, because the Bun runner has foreign
-- keys OFF and ON DELETE CASCADE would not fire; http/sse rows untouched, and
-- the tables are not rebuilt so the legacy command/args columns and the 0009
-- CHECK survive), 0011_mcp_managed_secrets.sql (managed MCP client secrets —
-- new `assistant_mcp_secrets` table, CREATE TABLE only, ciphertext only),
-- 0012_remove_mcp_secret_refs.sql (managed-only MCP client secrets — clears
-- every legacy `secret_ref` with one UPDATE, no DDL; the column stays legacy and
-- is never written again), 0013_jev_registry.sql (Jev moves out of env into
-- `assistant_jev_config` / `assistant_jev_secrets` / `assistant_jev_projects`),
-- 0014_provider_secrets.sql (provider credentials move into
-- `assistant_provider_secrets`; the legacy plaintext column stays dead for
-- Release N), 0015_chat_attachments.sql (chat attachments — one additive
-- `chat_attachments` table, thread-scoped via a composite FK to
-- `assistant_threads` with ON DELETE CASCADE), 0017_github_app_secrets.sql
-- (GitHub App credentials move into `github_app_secrets`; encrypted-only, scope
-- "github", AAD prefix "lexa-github-v1", no FK/plaintext — legacy plaintext
-- settings rows are NOT migrated and stay readable as a fallback). 0016 is
-- reserved by `0016_drop_provider_api_key.sql` (Release N+1) and is absent from
-- the chain; future migrations continue at 0018_*.sql.
-- 0018_user_project_roles_unique.sql de-dups `user_project_roles` (keeping the
-- admin row when both exist) and adds `ux_user_project_roles_user_project`
-- (user_id, project_id) so the one-role-per-(user, project) invariant is
-- enforceable without a PK rebuild (D1 has no ALTER).
-- 0019_workers_ai_provider_kind.sql widens the `kind` CHECK on both
-- `assistant_models` and `assistant_call_logs` to include `workers_ai` (keyless
-- Workers AI inference through the `env.AI` binding). SQLite cannot ALTER a
-- CHECK, so both tables are rebuilt create/copy/drop/rename with every row
-- copied verbatim; neither table has an inbound FK, so the rebuild is FK-safe
-- under D1's enforced foreign keys.
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
- **Backfill:** the pre-squash history inserted one `created` row per then-existing
  task (from `tasks.created_at`) plus one `archived` row per archived task
  (from `archived_at`) — a no-op on a fresh database. Rows created after the
  migration get their events from the services, not the backfill.
- **Comment edits/deletes** are soft: `edited_at` (UI "edited" marker) and
  `deleted_at` (hidden from timeline). No revision history — edit overwrites
  `body`.

### Assistant (Workers-only DO runtime) + removed agent-runtime tier
The document **Generate** button in the task/wiki editors and freeform chat both
run through the Workers-only Durable Object assistant (ADR-0003). There is no
external daemon, machine registry, or warm-session state anymore — the former
"Runtimes"/Blacksmith tier
was deleted by `0008_remove_agent_runtimes.sql` (tables `runtimes`, `machines`,
`runtime_events`, `runtime_sessions`, `runtime_task_logs` dropped; `runtime_tasks`
rebuilt+renamed to `assistant_tasks`; `assistant_settings.engine` +
`engine_switcher_enabled` dropped).

- **Task lifecycle:** `queued` → (assistant stream claims) `running` →
  `completed`/`failed`/`cancelled`. Claim is a conditional UPDATE
  (`WHERE id=? AND status='queued'`); a lost race surfaces `ASSISTANT_TASK_ACTIVE`.
- **Agents + skills:** every task carries `agent_id` + `skill_id` (global rule
  bundles, M2M bindings). There is exactly one builtin agent (`assistant`); the
  per-agent skill availability is the `lexa_agent_skills` junction only. The
  assistant stream loads the agent/skill instructions directly (no claim-carried
  files).
- **`document_sources`** persist per document (task or wiki page). `kind=wiki`
  stores the wiki page **slug** in `ref`; `kind=external` stores the URL. The server
  resolves wiki sources to page content; external URLs are fetched
  with an **SSRF guard** (DNS resolve → reject private/loopback/link-local/CGNAT).
- **Repo-content grounding:** the linked GitHub repo content (Contents: Read) is
  assembled per run from the project's `source_role` repos, capped by the
  `assistant_repo_cap` setting (env bootstrap `LXK_ASSISTANT_REPO_CAP`, default 3).
- **Auth:** every assistant endpoint is a normal Bearer/session-authenticated API
  call. The `x-runtime-token` daemon credential and the `/api/runtimes/*` routes
  no longer exist.
- **Recovery (no boot sweep):** in-flight turns run via the DO's `runFiber` +
  `chatRecovery` (ADR-0003 §B.5) — a turn survives isolate eviction/redeploy and
  on give-up is marked failed through the internal route. The former Bun
  boot-time stale-`running` sweep is removed with the Bun assistant code.
- **Vision resolution order** (per request): `primary_supports_images=1` → inline
  image parts; else `VISION_NOT_CONFIGURED` (409). The legacy `vision_model`
  delegation was removed in the squashed baseline.
- **Id rebind consequence (one-time, history):** threads keyed on the pre-squash
  agent id reset once — continue-vs-fresh saw an unknown agentId and started fresh.

### Managed secrets (`assistant_mcp_secrets` / `assistant_provider_secrets` / `assistant_jev_secrets` / `github_app_secrets`)
One plain assistant-tier module, `server/assistant/secrets.ts`, envelope-encrypts
every webapp-managed credential — MCP client tokens, LLM provider API keys, the
Jev API key, and GitHub App credentials (PEM + webhook secret). Each scope stores
its blob in its own table, keyed by its owner (`server_id` / `provider_id` /
`config_id` / the credential `name`); the master key lives only in the
environment (`LXK_SECRETS_MASTER_KEY`, with `LXK_SECRETS_MASTER_KEY_PREV` as the
rotation read path). Scopes are `mcp | provider | jev | github`, and a blob is
bound to its scope **and** owner through the AAD `<prefix>:<ownerId>` using a
frozen per-scope prefix (`lexa-mcp-v1` | `lexa-provider-v1` | `lexa-jev-v1` |
`lexa-github-v1`), so a blob copied onto another row or another scope fails to
decrypt. `lexa-mcp-v1` is frozen: stored MCP blobs authenticate against
`lexa-mcp-v1:<serverId>` and must keep opening.

- **One row per owner.** The owner id (or credential name) is the PRIMARY KEY in
  every table, so an owner has at most one stored blob. Upsert (`ON CONFLICT(...) DO UPDATE`) is
  the write, so re-entering a credential replaces the blob and rotates the IV in
  one statement pair.
- **Ciphertext never enters the registry.** Each blob lives only in its own
  table — a bare `SELECT *` of `assistant_mcp_servers` / `assistant_providers` /
  `assistant_jev_config` can never surface one. The registries read it through a
  `LEFT JOIN` aliased to `secret_ciphertext` / `secret_iv` / `secret_key_id`;
  **absence of a row means no credential**, which is how a secret-less client,
  a keyless provider, and an unconfigured Jev are represented.
- **MCP (0011).** `assistant_mcp_secrets` holds the client token. The legacy
  `assistant_mcp_servers.secret_ref` **reference** column is no longer a
  credential source: it is legacy, cleared by `0012_remove_mcp_secret_refs.sql`,
  and never written again (any repo write nulls it); a stale value is ignored by
  the public mapper and a stored legacy `secret_ref` with no blob hard-fails at
  connect until a write clears it.
- **Provider (0014).** `assistant_provider_secrets` holds the provider key,
  AAD-bound to the provider id. Release N ships the one-way boot backfill
  (`server/db/provider-secrets-backfill.ts`), which encrypts every non-empty
  `assistant_providers.api_key` into this table and then writes `''`. The legacy
  column is dead in Release N (only the backfill reads it) and is dropped in
  Release N+1 by `0016_drop_provider_api_key.sql`.
- **Jev (0013).** `assistant_jev_secrets` holds the API key as a singleton
  (`config_id = 'default'`, FK to `assistant_jev_config`), AAD-bound to that
  row; `key_hint` is the last 4 characters, display only. The config registry
  surfaces `hasKey` / `keyMask` and never the blob.
  `assistant_jev_projects` is the per-project opt-in (absence = disabled).
- **GitHub (0017).** `github_app_secrets` holds the App's `private_key` and
  `webhook_secret`, one row per credential name, AAD-bound to that name. It has
  no owner table and no FK (the App is an install singleton), and is written only
  by the in-app manifest connect flow (`POST /api/settings/github/setup`); a
  manual `PUT /api/settings/github` writes the legacy plaintext settings rows
  instead and deletes the matching encrypted row (last explicit write wins).
  Legacy plaintext `settings.github_private_key` / `github_webhook_secret` rows
  are never migrated and stay readable as a fallback: resolution is
  encrypted-first, and a present-but-unopenable encrypted row reads as unset —
  never as a plaintext fallback. The app id and slug stay plaintext settings
  rows (`github_app_id` / `github_app_slug`).
- **FK cascade + explicit delete.** `ON DELETE CASCADE` fires under the
  Workers/D1 runner, but the Bun runner runs with `PRAGMA foreign_keys = OFF`
  (`server/db/migrate.ts`), where it does not. The MCP repo therefore deletes the
  secret row explicitly before the parent `DELETE` (same lesson as 0010) —
  otherwise a deleted client would strand ciphertext no operator can read.
- **Columns are envelope, not credential.** `ciphertext` (base64 of
  `ciphertext || 128-bit tag`), `iv` (base64, 12 random bytes per write), and
  `key_id` — the **keyring slot** (`'active'` | `'prev'`), never a fingerprint,
  counter, or date. Slot naming is what makes rotation rewrap-free: an
  existing `prev` row keeps resolving through `LXK_SECRETS_MASTER_KEY_PREV`.
- **No plaintext column, ever.** The master key lives only in the environment
  (`LXK_SECRETS_MASTER_KEY`); each table is written exclusively by the encrypt
  path and read exclusively when opening a credential. Redaction rules exclude
  both plaintext and ciphertext from logs, reports, and error bodies.
- **Delete is crypto-free.** `deleteSecret` is a plain row delete, so the
  clear-a-secret affordance works on a deployment whose master key is gone.

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

### Task ticket keys — prefix + monotonic number, immutable once written
Every project gets a ticket-key prefix (`projects.key`, unique — e.g. "NIM" from the slug, derived by `server/task-key.ts`), and every task gets a stable key `PREFIX-n` (`tasks.key`, e.g. "NIM-12") with a per-project monotonic `tasks.number` (`UNIQUE(project_id, number)`). Keys are written once at create, immutable, never reused — `projects.next_task_number` is advanced and read in ONE atomic batch (the task INSERT computes `number`/`key` from the counter the same batch increments, so a failed insert rolls the increment back; `UNIQUE(project_id, number)` is the backstop). The columns are nullable only for the boot-time backfill (`server/db/task-keys-backfill.ts`); the app enforces non-null on write. `PREFIX-n` is accepted as a lookup alias wherever a task id is accepted.

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
    OR (SELECT COUNT(*) FROM tasks WHERE project_id = ?5 AND column_id = ?2 AND archived_at IS NULL)
       < COALESCE((SELECT wip_limit FROM columns WHERE id = ?2), 9223372036854775807)
  );
```

Normative: archived tasks do not count toward WIP limits.

`rowsChanged = 0` after confirming the task exists → `WipLimitExceeded` (409). Webhook-driven moves use a separate statement without the count clause (robots bypass WIP limits — see LAYERS.md).

- The `column_id = ?2` short-circuit prevents false `WipLimitExceeded` on pure reorders inside an at-limit column (the moving task would otherwise count itself).
- Count and last-key queries include `project_id` so `idx_tasks_board` (leftmost `project_id`) applies.
- Every task must belong to both a column and a swimlane. Columns are templates rendered inside swimlane rows. New projects get a default "Backlog" swimlane.
- **WIP limit is per-column total** — counts ALL tasks in the column across all swimlanes. The WIP badge in each swimlane row shows the same total, not per-swimlane count.

### Echo suppression (`synced_state`)
Every Lexa→GitHub state sync writes the state we pushed to `task_github_issues.synced_state` for that specific issue. The webhook handler compares the payload's issue state against `synced_state`: equal → our own echo → skip. Without this, every move triggers a self-reinforcing webhook storm.

### Content echo suppression (`pushed_title` / `pushed_body`)
Content sync (title + description) is asymmetric: Lexa pushes on task save (TipTap → Markdown), GitHub pushes back via the `edited` webhook (Markdown → TipTap). The webhook echo check fetches the issue and skips only when the fetched title **and** body both match `pushed_title`/`pushed_body` after trimming + CRLF→LF normalization (our pushes always send title+body together, so a title match alone is not proof of echo). `push_failed` records a failed Lexa→GitHub content push for the inline divergence badge ("out of sync — edit not pushed").

### One task ↔ many issues
Multiple GitHub issues can link to one task. Each link has its own `synced_state` for per-issue echo suppression. The webhook looks up by `issue_id` in `task_github_issues` to find the task.

### Attachments — per-project rows, global blobs
Two-level model: `attachments` rows are scoped to a project (UNIQUE(project_id, sha256) — the dedupe key), while the bytes live in ONE content-addressed object per sha256 (`storage_key = "blobs/<sha256>"`) shared across projects. Consequences:

- **Dedupe hit** (same project, same bytes): the upload returns the EXISTING row unchanged — no new row, no second activity row, no blob rewrite.
- **Blob lifecycle:** a blob is deleted only when the last `attachments` row referencing its storage_key goes (refcount query at delete time). Delete authority: uploader OR project admin.
- **Orphan blobs are possible and harmless:** FK cascades (project/task/page delete) remove rows without app-level blob cleanup, as does a crash between blob write and row insert. Re-uploading the same bytes re-links the orphan. Periodic GC is out of scope.
- **mime_type is server-derived** from magic-byte sniffing at upload; serving inline is allowed ONLY for image/* and application/pdf — everything else downloads via Content-Disposition: attachment with X-Content-Type-Options: nosniff.

### Chat attachments — thread-scoped, temporary
`chat_attachments` (0015) holds files attached to an Assistant chat message: images feed the existing vision path (`image-ref` parts) and PDF/Markdown/plain-text files become model-visible extracted text (`document-ref` parts, persisted in `assistant_threads.messages` like image refs). Differences from `attachments`:

- **Lifecycle:** a row is bound to its conversation by the composite FK `(document_type, document_id) → assistant_threads(document_type, document_id)` with `ON DELETE CASCADE`; it dies with the thread (never listed on a project's attachment surface, never emits `task_activity`).
- **No dedupe:** `chat_attachments` carries no `UNIQUE(project_id, sha256)` — every upload is its own row, though the blob stays content-addressed and shared.
- **Blob lifecycle:** the same refcount rule as `attachments`, but counted across BOTH tables — a blob is dropped only when the last row in `attachments` **and** `chat_attachments` referencing its `storage_key` goes. Orphan blobs remain possible and harmless.
- **Server-side extraction:** text/markdown decode directly; PDFs extract through `unpdf` (`server/services/assistant-helpers.ts`). A document that yields no text blocks the send with `ATTACHMENT_EXTRACTION_FAILED`.
- **Caps (D4):** ≤3 attachments per message (images + documents share the count), ≤5 MB per file, ≤10 MB per message; zero-byte and unsupported types rejected. Kill switch `LXK_DISABLE_CHAT_ATTACHMENTS=1` disables uploads and sends-with-attachments.

### FTS5 for `search_wiki`
The `wiki_fts` external-content table + triggers keep the index in sync automatically. The app maintains `content_text` (plain-text projection of TipTap JSON) on every wiki write — searching raw TipTap JSON would match syntax tokens, not words.

### Mentions are document nodes, not rows
A mention is a TipTap node `{ type: "mention", attrs: { refType: "task"|"wiki", refId, label } }` living inside the existing description/content JSON — no table, column, index, or notification rows. Autocomplete is served by a read-only cross-repo search (`MentionService`, cap 8); GitHub push renders mentions as absolute deep links (`${PUBLIC_URL}/{slug}/...`) while pull degrades them back to plain links, keeping `pushed_body` byte-stable for echo suppression.

### `updated_at` is app-maintained
Every repo `update*` method sets `updated_at = datetime('now')` in the same statement. No triggers — the write path is already centralized in repositories.

### Atomicity: batch, not interactive transactions
Every mutation is either a single statement or one `batch()`/`batchResults()`
array (`server/db/db.ts`; the driver contract lives in `server/db/driver.ts`).
`batch()` is atomic all-or-nothing on BOTH drivers — bun-sqlite wraps the array
in `db.transaction`, D1 calls the binding's `batch()`. `withTx` is a Bun-only
convenience and is a documented no-op on D1, so every multi-write site uses one
batch. Read-dependent sites either fold the read into the batch SQL (task-create
counter: the INSERT computes `number`/`key` from the counter it increments in
the same batch; archive cascades: one set-based `UPDATE` + `INSERT ... SELECT`;
wiki restore, task-link remove, source remove, project create, and
the assistant-task terminal transitions read first and then run every write in
one batch) or explicitly accept a read-compute-retry window (position anchoring,
WIP move verification). The two sites with a reciprocal-write cycle/ancestor
guard — wiki update's reparent cycle check and task-link add's subtask_of
ancestor check — keep `withTx` around the guard reads and the write batch: on
Bun `BEGIN IMMEDIATE` serializes the check against a reciprocal writer; on D1
`withTx` no-ops and the guard-vs-write window is the accepted residual.

### SQLite notes (unchanged from v1)
- TEXT UUIDs via `crypto.randomUUID()` in Bun.
- SQLite is local (WAL) — reads are immediate. Frontend still updates its cache from mutation responses (TanStack Query `setQueryData`), not refetch, because the mutation response is the authoritative state.
- No row-size limits at this scale: fine for TipTap docs.
- `webhook_events` grows unboundedly → periodic prune (`DELETE WHERE received_at < datetime('now','-7 days')`) on a timer or at boot.

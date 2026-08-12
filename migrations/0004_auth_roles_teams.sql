-- Auth, roles & teams rework (2026-08-13)
-- Better Auth 1.6.27 in-process auth; teams = organizations; env-only superadmin.

-- ── users: re-key to Better Auth ids + role narrowing + auth columns ──
-- Better Auth id generator = 32-char [a-zA-Z0-9] (generateId(), verified by
-- spike). This migration re-keys with lower(hex(randomblob(16))) — 32 lowercase
-- hex chars, a subset of the generator's alphabet; ids are opaque and per-row
-- unique (randomblob is re-evaluated per row).
-- The role CHECK must narrow to superadmin|member, so the table is rebuilt
-- (SQLite cannot alter a CHECK). The old table is DROPPED and the new one
-- RENAMED into place — child FK references resolve by table name at DML time,
-- so they keep working (spike-verified with foreign_keys=ON afterwards).
-- The migration runner opens bun:sqlite with foreign_keys OFF (bun default),
-- so the rebuild + child re-key are not FK-thwarted.
CREATE TABLE users_new (
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
  banExpires     TEXT,
  legacy_id      TEXT
);

INSERT INTO users_new (id, email, name, role, created_at, last_seen, email_verified, image, updated_at, legacy_id)
SELECT lower(hex(randomblob(16))), email, name,
       CASE WHEN role = 'admin' THEN 'superadmin' ELSE 'member' END,
       created_at, last_seen, 1, NULL, datetime('now'), id
FROM users;

UPDATE user_project_roles SET user_id = (SELECT u.id FROM users_new u WHERE u.legacy_id = user_project_roles.user_id);
UPDATE api_keys           SET user_id = (SELECT u.id FROM users_new u WHERE u.legacy_id = api_keys.user_id);
UPDATE task_comments      SET author_id = (SELECT u.id FROM users_new u WHERE u.legacy_id = task_comments.author_id);
UPDATE task_activity      SET actor_user_id = (SELECT u.id FROM users_new u WHERE u.legacy_id = task_activity.actor_user_id);

ALTER TABLE users_new DROP COLUMN legacy_id;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- admin_emails setting deleted — superadmin is env-only (LXK_ADMIN_EMAILS),
-- applied at provisioning only, never edited at runtime.
DELETE FROM settings WHERE key = 'admin_emails';

-- ── Better Auth 1.6.27 tables ──
-- Authoritative shapes from `bunx --bun auth@latest generate` (spike output).
-- Timestamps are TEXT: the kysely adapter serializes Date as ISO 8601 strings
-- (spike-verified). session gains activeOrganizationId from the organization
-- plugin. No `invitation` table — team membership is direct member-row
-- insertion (spec: no email invites at team level).
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
);

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

-- ── workspace_invitations (superadmin-issued app-member invites; lexa conventions) ──
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

-- ── projects: team ownership (NULL = unassigned, superadmin-only) ──
ALTER TABLE projects ADD COLUMN team_id TEXT REFERENCES organization(id) ON DELETE SET NULL;
CREATE INDEX idx_projects_team ON projects(team_id);

-- ── runtimes: team scoping (NULL = global superadmin runtime) ──
-- runtimes are ephemeral infra: a deleted team must not RESTRICT them
-- (TEAM_HAS_PROJECTS guards projects only) — unassign instead.
ALTER TABLE runtimes ADD COLUMN team_id TEXT REFERENCES organization(id) ON DELETE SET NULL;
CREATE INDEX idx_runtimes_team ON runtimes(team_id);

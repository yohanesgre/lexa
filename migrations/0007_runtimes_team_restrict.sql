-- 0007: runtimes.team_id ON DELETE SET NULL -> ON DELETE RESTRICT.
--
-- Deleting an organization must never silently widen a team-scoped runtime
-- into a global one: a NULL team_id claims any team's tasks. The FK backstop
-- now rejects the org DELETE while runtimes are still bound; reassign or
-- detach them first (PATCH /api/runtimes/:id { teamId }).
--
-- SQLite has no ALTER for a FK action, so runtimes is rebuilt in place
-- (create -> copy -> drop -> rename). The only child FK is
-- runtime_tasks.runtime_id (ON DELETE SET NULL): the Bun runner disables
-- FK enforcement for the run, but the Workers/D1 runner enforces it, so the
-- DROP's implicit DELETE would NULL those links. They are copied aside and
-- restored after the rename so both engines reach the same end state.
-- Index definitions are reproduced verbatim from 0001_init.sql.
-- No PRAGMA foreign_key_check here (read pragmas are not D1 batch-safe); the
-- FK result and link preservation are asserted by the migration tests.

CREATE TABLE runtime_tasks_runtime_link (id TEXT PRIMARY KEY, runtime_id TEXT);
INSERT INTO runtime_tasks_runtime_link
  SELECT id, runtime_id FROM runtime_tasks WHERE runtime_id IS NOT NULL;

CREATE TABLE runtimes_new (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  model          TEXT NOT NULL DEFAULT '',
  extra_args     TEXT NOT NULL DEFAULT '[]',
  models_catalog TEXT NOT NULL DEFAULT '[]',
  agent          TEXT NOT NULL DEFAULT '',
  print_logs     INTEGER NOT NULL DEFAULT 0,
  log_level      TEXT NOT NULL DEFAULT '',
  agents_catalog TEXT NOT NULL DEFAULT '[]',
  machine_id     TEXT REFERENCES machines(id) ON DELETE SET NULL,
  team_id        TEXT REFERENCES organization(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  hostname       TEXT NOT NULL DEFAULT '',
  last_seen      TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO runtimes_new (id, name, provider, model, extra_args, models_catalog, agent,
  print_logs, log_level, agents_catalog, machine_id, team_id, status, hostname,
  last_seen, last_error, created_at)
  SELECT id, name, provider, model, extra_args, models_catalog, agent,
         print_logs, log_level, agents_catalog, machine_id, team_id, status, hostname,
         last_seen, last_error, created_at
  FROM runtimes;

DROP TABLE runtimes;
ALTER TABLE runtimes_new RENAME TO runtimes;

CREATE INDEX idx_runtimes_machine ON runtimes(machine_id);
CREATE INDEX idx_runtimes_team ON runtimes(team_id);

UPDATE runtime_tasks
   SET runtime_id = (SELECT l.runtime_id FROM runtime_tasks_runtime_link l WHERE l.id = runtime_tasks.id)
 WHERE id IN (SELECT id FROM runtime_tasks_runtime_link);

DROP TABLE runtime_tasks_runtime_link;

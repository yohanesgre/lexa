-- 0026_assistant_tasks_nullable_skill.sql — auto skill selection (LX-133).
--
-- The editor Generate panel no longer carries a skill picker: a run may be
-- enqueued with no skill at all (`skill_id` omitted), and the assistant picks
-- the best-matching skill itself from its bound catalog. That makes
-- `assistant_tasks.skill_id` optional — it stays non-null only when the caller
-- supplies an explicit skill id.
--
-- SQLite cannot drop a NOT NULL constraint in place (`ALTER COLUMN`/`DROP
-- COLUMN` are unsupported by D1), so the table is rebuilt
-- create/copy/drop/rename following 0023. No inbound FK targets
-- `assistant_tasks`, so the rebuild is FK-safe under D1's enforced keys.
-- Every row is copied verbatim; both task indexes are recreated.
CREATE TABLE assistant_tasks_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES lexa_agents(id),
  skill_id      TEXT REFERENCES lexa_skills(id),
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
INSERT INTO assistant_tasks_new (id, project_id, document_type, document_id, agent_id, skill_id,
  extra_prompt, selection, status, result, error, created_at, started_at, finished_at)
  SELECT id, project_id, document_type, document_id, agent_id, skill_id,
         extra_prompt, selection, status, result, error, created_at, started_at, finished_at
  FROM assistant_tasks;
DROP TABLE assistant_tasks;
ALTER TABLE assistant_tasks_new RENAME TO assistant_tasks;
CREATE INDEX idx_assistant_tasks_created ON assistant_tasks(created_at DESC, id DESC);
CREATE INDEX idx_assistant_tasks_status ON assistant_tasks(status, created_at);

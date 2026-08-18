-- Task ticket keys (Jira-style). Columns stay nullable — backfilled in code
-- at boot (server/db/task-keys-backfill.ts); app enforces non-null on write.
ALTER TABLE projects ADD COLUMN key TEXT;
ALTER TABLE projects ADD COLUMN next_task_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN key TEXT;
ALTER TABLE tasks ADD COLUMN number INTEGER;
CREATE UNIQUE INDEX idx_projects_key ON projects(key);
CREATE UNIQUE INDEX idx_tasks_project_number ON tasks(project_id, number);
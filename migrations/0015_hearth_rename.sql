-- Hearth rename (phase 1): task/session tables + activity types +
-- settings key. Agent/skill catalog tables were already renamed to lexa_* in
-- migration 0010. Historical rows keep their frozen message text; only the
-- activity type discriminators are rewritten here.

ALTER TABLE forge_tasks RENAME TO hearth_tasks;
ALTER TABLE forge_task_logs RENAME TO hearth_task_logs;
ALTER TABLE forge_sessions RENAME TO hearth_sessions;
-- SQLite has no ALTER INDEX RENAME — drop and recreate with the new names
-- (definitions copied verbatim from migrations 0001/0010, retargeted).
DROP INDEX idx_forge_tasks_created;
DROP INDEX idx_forge_tasks_status;
DROP INDEX idx_forge_task_logs_task;
DROP INDEX idx_forge_tasks_kind_status;
CREATE INDEX idx_hearth_tasks_created ON hearth_tasks(created_at DESC, id DESC);
CREATE INDEX idx_hearth_tasks_status ON hearth_tasks(status, created_at);
CREATE INDEX idx_hearth_task_logs_task ON hearth_task_logs(task_id, created_at);
CREATE INDEX idx_hearth_tasks_kind_status ON hearth_tasks(kind, status);
UPDATE task_activity SET type='hearth_completed' WHERE type='forge_completed';
UPDATE task_activity SET type='hearth_failed' WHERE type='forge_failed';
UPDATE task_activity SET type='hearth_cancelled' WHERE type='forge_cancelled';
UPDATE settings SET key='hearth_repo_cap' WHERE key='forge_repo_cap';

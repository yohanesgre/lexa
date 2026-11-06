-- 0032_tasks_key_index.sql
-- Ticket-key resolution: every `PREFIX-n` route param runs
-- `WHERE tasks.key = ?` (server/api/task-id.ts) before the handler, and the
-- table's only unique key was (project_id, number), so the lookup scanned all
-- tasks. The key is immutable and unique per project prefix (invariant 13), so
-- a plain index is the narrow backstop for that lookup.
CREATE INDEX IF NOT EXISTS idx_tasks_key ON tasks(key);

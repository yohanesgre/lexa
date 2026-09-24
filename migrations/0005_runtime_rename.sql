-- Hearth -> Runtimes namespace rename. Data is migrated, never dropped.
-- Hard cutover: no aliases in code. Ordered: table renames -> index renames
-- -> activity value UPDATEs -> settings key -> agent-id rebinds.
--
-- Index renames use DROP INDEX + CREATE INDEX: SQLite has no
-- `ALTER INDEX ... RENAME TO` (verified on 3.53.2), and the index
-- definitions are reproduced verbatim from 0001_init.sql. Nothing here
-- uses RENAME COLUMN, so the D1 table-rebuild fallback is not needed.
--
-- The agent-id rebind below is FK-safe and does NOT rely on
-- `PRAGMA foreign_keys=OFF`: the Bun runner disables enforcement for the
-- run, but the Workers/D1 runner enforces FKs, so this file must succeed
-- under both. Rebind order: free the UNIQUE name -> insert the new parent
-- rows -> repoint every referencing child -> delete the old parent rows.

ALTER TABLE "hearth_tasks" RENAME TO "runtime_tasks";
ALTER TABLE "hearth_task_logs" RENAME TO "runtime_task_logs";
ALTER TABLE "hearth_sessions" RENAME TO "runtime_sessions";

DROP INDEX idx_hearth_tasks_created;
CREATE INDEX idx_runtime_tasks_created ON runtime_tasks(created_at DESC, id DESC);
DROP INDEX idx_hearth_tasks_status;
CREATE INDEX idx_runtime_tasks_status ON runtime_tasks(status, created_at);
DROP INDEX idx_hearth_task_logs_task;
CREATE INDEX idx_runtime_task_logs_task ON runtime_task_logs(task_id, created_at);
DROP INDEX idx_hearth_tasks_kind_status;
CREATE INDEX idx_runtime_tasks_kind_status ON runtime_tasks(kind, status);

UPDATE task_activity SET type = 'runtime_completed' WHERE type = 'hearth_completed';
UPDATE task_activity SET type = 'runtime_failed' WHERE type = 'hearth_failed';
UPDATE task_activity SET type = 'runtime_cancelled' WHERE type = 'hearth_cancelled';

UPDATE settings SET key = 'runtime_repo_cap' WHERE key = 'hearth_repo_cap';

-- Agent-id rebinds, FK-safe under an enforcing runner. The naive
-- `UPDATE child SET agent_id = 'herald'` fails when foreign_keys=ON: the
-- parent row does not exist yet. Instead insert the parents first, repoint
-- the children, then drop the old parents. `name` is UNIQUE, so suffix the
-- old rows to free their names; SUBSTR restores them on the new rows.
UPDATE lexa_agents SET name = name || ' [rebind]' WHERE id IN ('hearth-herald', 'hearth-blacksmith');

INSERT INTO lexa_agents (id, name, description, instructions, is_builtin, created_at, updated_at)
  SELECT 'herald', SUBSTR(name, 1, LENGTH(name) - 9), description, instructions, is_builtin, created_at, updated_at
  FROM lexa_agents WHERE id = 'hearth-herald';
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin, created_at, updated_at)
  SELECT 'blacksmith', SUBSTR(name, 1, LENGTH(name) - 9), description, instructions, is_builtin, created_at, updated_at
  FROM lexa_agents WHERE id = 'hearth-blacksmith';

UPDATE runtime_tasks SET agent_id = 'herald' WHERE agent_id = 'hearth-herald';
UPDATE runtime_tasks SET agent_id = 'blacksmith' WHERE agent_id = 'hearth-blacksmith';
UPDATE runtime_sessions SET agent_id = 'herald' WHERE agent_id = 'hearth-herald';
UPDATE runtime_sessions SET agent_id = 'blacksmith' WHERE agent_id = 'hearth-blacksmith';
UPDATE lexa_agent_skills SET agent_id = 'herald' WHERE agent_id = 'hearth-herald';
UPDATE lexa_agent_skills SET agent_id = 'blacksmith' WHERE agent_id = 'hearth-blacksmith';
UPDATE herald_threads SET agent_id = 'herald' WHERE agent_id = 'hearth-herald';
UPDATE herald_threads SET agent_id = 'blacksmith' WHERE agent_id = 'hearth-blacksmith';

DELETE FROM lexa_agents WHERE id IN ('hearth-herald', 'hearth-blacksmith');

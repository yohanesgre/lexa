-- Migration 0007: swimlane_id becomes NOT NULL
-- Step 1: create default swimlane for projects with orphan tasks
INSERT OR IGNORE INTO swimlanes (id, project_id, name, description, position)
SELECT 'seed-sw-def-' || p.id, p.id, 'Default', '', 999
FROM projects p
WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.swimlane_id IS NULL);

-- Step 2: assign orphans
UPDATE tasks SET swimlane_id = (
  SELECT id FROM swimlanes s WHERE s.project_id = tasks.project_id AND s.name = 'Default'
) WHERE swimlane_id IS NULL;

-- Step 3: recreate with NOT NULL
CREATE TABLE tasks_new (
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
);

INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

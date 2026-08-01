-- ============================================================
-- 0010 — Per-project customizable task fields (priority & type)
-- ============================================================
-- Replaces the fixed enums (tasks.priority CHECK, tasks.type CHECK) with
-- project-scoped option lists. tasks.priority/type become FK references.

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

-- Backfill: seed the legacy 4+4 options per project, then point tasks at them.
-- Legacy values map 1:1 (urgent/high/medium/low · feature/bug/task/asset).
INSERT INTO priority_options (id, project_id, label, color, position)
SELECT 'prio-' || p.id || '-0', p.id, 'Urgent', '#FF4444', 0 FROM projects p
UNION ALL
SELECT 'prio-' || p.id || '-1', p.id, 'High', '#F0C040', 1 FROM projects p
UNION ALL
SELECT 'prio-' || p.id || '-2', p.id, 'Medium', '#22D3EE', 2 FROM projects p
UNION ALL
SELECT 'prio-' || p.id || '-3', p.id, 'Low', '#6B6560', 3 FROM projects p;

INSERT INTO type_options (id, project_id, label, color, position)
SELECT 'type-' || p.id || '-0', p.id, 'Feature', '#4ADE80', 0 FROM projects p
UNION ALL
SELECT 'type-' || p.id || '-1', p.id, 'Bug', '#FF4444', 1 FROM projects p
UNION ALL
SELECT 'type-' || p.id || '-2', p.id, 'Task', '#22D3EE', 2 FROM projects p
UNION ALL
SELECT 'type-' || p.id || '-3', p.id, 'Asset', '#F472B6', 3 FROM projects p;

-- Rewrite tasks to the seeded option ids (legacy value → matching option).
UPDATE tasks SET priority = 'prio-' || project_id || '-' || CASE priority
  WHEN 'urgent' THEN '0' WHEN 'high' THEN '1' WHEN 'medium' THEN '2' WHEN 'low' THEN '3'
  ELSE '2' END;

UPDATE tasks SET type = 'type-' || project_id || '-' || CASE type
  WHEN 'feature' THEN '0' WHEN 'bug' THEN '1' WHEN 'task' THEN '2' WHEN 'asset' THEN '3'
  ELSE '2' END;

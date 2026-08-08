-- Milestone deadlines: swimlane due date + kind, lane/task archive + card deadlines.
ALTER TABLE swimlanes ADD COLUMN due_at TEXT;  -- YYYY-MM-DD, NULL = no deadline
ALTER TABLE swimlanes ADD COLUMN archived_at TEXT;  -- NULL = live
ALTER TABLE swimlanes ADD COLUMN kind TEXT NOT NULL DEFAULT 'milestone'
  CHECK (kind IN ('backlog','milestone'));
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';
ALTER TABLE tasks ADD COLUMN due_at TEXT;  -- YYYY-MM-DD, NULL = none; <= lane due_at

-- Existing 'Default' lanes become the system Backlog lane (identity = kind, not name).
UPDATE swimlanes SET name = 'Backlog', kind = 'backlog' WHERE name = 'Default';

-- Projects without a Backlog lane (lane renamed historically) get one at the end.
INSERT INTO swimlanes (id, project_id, name, description, position, kind)
SELECT 'bl-' || substr(id, 1, 8) || '-' || hex(randomblob(4)), id, 'Backlog', '',
       (SELECT COALESCE(MAX(position), -1) + 1 FROM swimlanes s WHERE s.project_id = p.id), 'backlog'
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM swimlanes s2 WHERE s2.project_id = p.id AND s2.kind = 'backlog');

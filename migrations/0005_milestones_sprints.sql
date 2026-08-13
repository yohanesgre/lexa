-- Milestones & sprint-aware swimlanes (2026-08-13)
-- milestones: goal wrapper above sprints; due_at is the target date (YYYY-MM-DD).
CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  due_at      TEXT,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_proj ON milestones(project_id, position);

-- swimlanes rebuild: kind CHECK narrows to ('backlog','sprint'); existing
-- 'milestone' rows become 'sprint'. New columns: milestone_id (NULL = loose
-- sprint; ON DELETE SET NULL loosens sprints when a milestone is deleted)
-- and start_at (YYYY-MM-DD sprint start). due_at stays the sprint deadline.
CREATE TABLE swimlanes_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  due_at      TEXT,
  archived_at TEXT,
  start_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'sprint'
              CHECK (kind IN ('backlog','sprint')),
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL
);
INSERT INTO swimlanes_new (id, project_id, name, description, position, due_at, archived_at, start_at, kind, milestone_id)
  SELECT id, project_id, name, description, position, due_at, archived_at, NULL,
         CASE WHEN kind = 'backlog' THEN 'backlog' ELSE 'sprint' END,
         NULL
  FROM swimlanes;
DROP TABLE swimlanes;
ALTER TABLE swimlanes_new RENAME TO swimlanes;
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';
CREATE INDEX idx_swimlanes_proj ON swimlanes(project_id, position);
CREATE INDEX idx_swimlanes_milestone ON swimlanes(project_id, milestone_id, position);

-- columns: explicit done marker (independent of github_state mapping).
ALTER TABLE columns ADD COLUMN is_done INTEGER NOT NULL DEFAULT 0;

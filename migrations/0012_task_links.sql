-- ============================================================
-- 0012 — Task links (subtask_of / blocked_by / related_to)
-- ============================================================
-- Directed links between tasks. Semantics:
--   subtask_of : from = child, to = parent. Child inherits parent's column.
--                Moving a parent cascades to its children. Deleting a parent
--                with children is blocked (HAS_CHILDREN). No cycles.
--   blocked_by : from = blocked task, to = blocker. Informational only.
--   related_to : symmetric display, stored once (from→to).
CREATE TABLE task_links (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN ('subtask_of', 'blocked_by', 'related_to')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_task_id, to_task_id, relation)
);
CREATE INDEX idx_task_links_from ON task_links(from_task_id);
CREATE INDEX idx_task_links_to   ON task_links(to_task_id);
CREATE INDEX idx_task_links_proj ON task_links(project_id);

-- ============================================================
-- Task archive — soft-archive flag (NULL = live, timestamp = archived)
-- Archived tasks keep column/swimlane/position; board/WIP/count
-- queries exclude them unless includeArchived is set.
-- ============================================================
ALTER TABLE tasks ADD COLUMN archived_at TEXT;

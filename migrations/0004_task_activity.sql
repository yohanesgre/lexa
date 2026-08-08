-- Task activity timeline + comments (docs/specs/ACTIVITY_COMMENTS.md)
-- Append-only by design: rows are never pruned (contrast: webhook_events 7-day).
-- INTEGER PRIMARY KEY: rowid is monotonic — second-granularity created_at ties
-- order by id; UUID text ids would not order chronologically.
CREATE TABLE task_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL: agent/system
  author_kind  TEXT NOT NULL DEFAULT 'user'
               CHECK (author_kind IN ('user','agent','system')),
  author_label TEXT NOT NULL,        -- frozen at write time
  body         TEXT NOT NULL,        -- TipTap JSON doc (≤64KB, non-empty)
  edited_at    TEXT,                 -- set on edit → UI "edited" marker
  deleted_at   TEXT,                 -- soft delete → hidden from timeline
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);

CREATE TABLE task_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_label   TEXT NOT NULL,       -- frozen display name
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                                     -- agent: key owner; user: their id; NULL: unbound/system
  type          TEXT NOT NULL,       -- enum in shared/types.ts (no CHECK — growing set)
  message       TEXT NOT NULL,       -- frozen at write time; the record
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);

-- Backfill: one 'created' row per existing task; archived tasks also get 'archived'.
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at)
  SELECT id, 'system', 'system', NULL, 'created', 'Task created', created_at FROM tasks;
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at)
  SELECT id, 'system', 'system', NULL, 'archived', 'Task archived', archived_at FROM tasks WHERE archived_at IS NOT NULL;

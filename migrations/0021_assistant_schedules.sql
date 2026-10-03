-- 0021_assistant_schedules.sql — scheduled assistant runs (ADR-0004 §4; H7).
--
-- The 15-minute Worker cron dispatcher selects due rows, creates a
-- `kind='schedule'` row in `assistant_runs`, and advances `next_run_at` in the
-- same transaction. `thread_key` is the target thread; NULL means "create a
-- dedicated schedule thread" (the dispatcher derives one).
CREATE TABLE assistant_schedules (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_key       TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  cron             TEXT,
  interval_seconds INTEGER,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  last_run_id      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((cron IS NOT NULL AND trim(cron) <> '') OR (interval_seconds IS NOT NULL AND interval_seconds > 0))
);

CREATE INDEX idx_assistant_schedules_due ON assistant_schedules(enabled, next_run_at);
CREATE INDEX idx_assistant_schedules_project ON assistant_schedules(project_id, created_at DESC);

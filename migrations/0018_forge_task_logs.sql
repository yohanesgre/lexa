-- ============================================================
-- 0018 — Forge: per-task activity log (live status feed)
-- ============================================================
-- The daemon streams progress lines (claim, model, agent start,
-- context load, generating, done) so the UI can show what a task
-- is doing right now. One row per log line, append-only.
CREATE TABLE forge_task_logs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES forge_tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_forge_task_logs_task ON forge_task_logs(task_id, created_at);

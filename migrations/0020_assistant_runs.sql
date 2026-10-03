-- 0020_assistant_runs.sql — delegation run registry (ADR-0004 §3; H3).
--
-- Facet-backed background runs dispatched from a thread DO. The parent DO
-- owns the live SDK run; this D1 row is the durable registry the Worker
-- surfaces (run cards, admin drill-in, call-log attribution) read. Transitions
-- are atomic conditional UPDATEs and idempotent.
--
-- No `task_activity` is emitted for `chat_run`/`schedule` kinds — the
-- emission invariant #12 applies to task document runs only.
CREATE TABLE assistant_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_key    TEXT NOT NULL,
  -- Reserved for nested runs (D4 defers nesting; always NULL in v1).
  parent_run_id TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('chat_run', 'document', 'schedule')),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  goal          TEXT NOT NULL,
  result        TEXT,
  error         TEXT,
  budget_ms     INTEGER,
  steps_used    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX idx_assistant_runs_thread ON assistant_runs(thread_key, created_at DESC);
CREATE INDEX idx_assistant_runs_project_status ON assistant_runs(project_id, status);

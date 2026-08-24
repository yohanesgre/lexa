-- Herald write tools v2: per-write approval queue.
-- Write-tool proposals persist here at proposal time; the owner approves or
-- rejects each row; resume executes approved rows in seq order. TTL is lazy
-- (flipped to 'expired' on decide/resume/transcript reads) — no timer.

CREATE TABLE herald_pending_writes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  execution_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (document_type, document_id) REFERENCES herald_threads(document_type, document_id) ON DELETE CASCADE
);
CREATE INDEX idx_herald_pending_batch ON herald_pending_writes(batch_id, seq);
CREATE INDEX idx_herald_pending_thread ON herald_pending_writes(document_type, document_id, status);

ALTER TABLE task_activity ADD COLUMN via_herald INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_comments ADD COLUMN via_herald INTEGER NOT NULL DEFAULT 0;
ALTER TABLE herald_settings ADD COLUMN write_tools TEXT NOT NULL DEFAULT '';

-- 0029_assistant_permission_mode_resume_claims.sql — W1 server hardening
-- (ADR-0005 §Port P1/P3). Two additive pieces for the in-process tier:
--
-- 1. `assistant_threads.permission_mode` — the sticky per-chat WRITE-tool
--    permission (`ask` | `auto` | `deny`), captured at TURN START from the send
--    envelope (absent → the stored sticky value) and persisted so a reload
--    re-hydrates the composer picker. Nullable: a pre-column row reads as
--    "ask" through the shared resolver (`resolveAssistantToolPermissionMode`).
--    Chat-only (D5); task/wiki runs never write it.
-- 2. `assistant_resume_claims` — one reservation per approval batch so a
--    retry, a double-click, or two tabs cannot re-execute the same approved
--    writes (LX-80). `INSERT OR IGNORE` on the batch id is the atomic claim;
--    the row is released when the batch is not executable (still pending / no
--    rows) and kept once it has been executed (or is indeterminate).
--
-- Additive only: a plain ALTER (same shape as 0022/0024/0028) + a new table.
ALTER TABLE assistant_threads ADD COLUMN permission_mode TEXT;

CREATE TABLE assistant_resume_claims (
  batch_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

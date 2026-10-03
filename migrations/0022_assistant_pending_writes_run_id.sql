-- 0022_assistant_pending_writes_run_id.sql — run attribution on write proposals
-- (ADR-0004 §3; plan line 140). A delegated run's `ask`-mode proposals persist
-- with the id of the run that proposed them, so the approval carousel can
-- attribute each chip back to its run. Nullable: regular chat/document proposals
-- have no run id, and every pre-existing row predates attribution.
ALTER TABLE assistant_pending_writes ADD COLUMN proposed_by_run_id TEXT;

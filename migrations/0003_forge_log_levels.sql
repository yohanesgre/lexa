-- Forge activity-log levels: the daemon classifies each line ONCE at write
-- time (stream + tuned matcher, shared/forge-log.ts) and the UI renders the
-- stored level — no text matching at render time. Legacy rows default to
-- out/info (the UI falls back to the shared classifier for rows that still
-- carry the old [stderr] marker).
ALTER TABLE forge_task_logs ADD COLUMN stream TEXT NOT NULL DEFAULT 'out';
ALTER TABLE forge_task_logs ADD COLUMN level TEXT NOT NULL DEFAULT 'info';

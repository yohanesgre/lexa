-- Herald -> Assistant namespace rename. Data is migrated, never dropped.
-- Hard cutover: no aliases in code. Ordered: table renames -> index
-- DROP/CREATE -> settings rebuild (CHECK change) -> value UPDATEs ->
-- via_herald column rebuilds -> agent-id rebind.
--
-- D1 constraints (same as 0005): `ALTER TABLE ... RENAME TO` supported;
-- `ALTER INDEX ... RENAME TO` does NOT exist (DROP INDEX + CREATE INDEX);
-- `RENAME COLUMN`/`DROP COLUMN` NOT supported -> the via_herald renames are
-- create/copy/drop rebuilds. No statement relies on FK enforcement being off:
-- the Bun runner disables FKs for the run, the Workers/D1 runner enforces
-- them, so this file must succeed under both. Rebind order: insert the new
-- parent row -> repoint every referencing child -> delete the old parent.

-- 1. table renames
ALTER TABLE "herald_threads" RENAME TO "assistant_threads";
ALTER TABLE "herald_pending_writes" RENAME TO "assistant_pending_writes";
ALTER TABLE "herald_providers" RENAME TO "assistant_providers";
ALTER TABLE "herald_model_prices" RENAME TO "assistant_model_prices";
ALTER TABLE "herald_provider_health" RENAME TO "assistant_provider_health";
ALTER TABLE "herald_models" RENAME TO "assistant_models";
ALTER TABLE "herald_call_logs" RENAME TO "assistant_call_logs";
-- herald_settings is rebuilt in step 3 (CHECK/DEFAULT change); its FK to
-- assistant_providers is correct because providers were renamed first.

-- 2. index renames (definitions verbatim from 0001_init.sql)
DROP INDEX idx_herald_threads_chat_list;
CREATE INDEX idx_assistant_threads_chat_list ON assistant_threads(project_id, owner_user_id, pinned DESC, updated_at DESC)
  WHERE document_type = 'chat';
DROP INDEX idx_herald_pending_batch;
CREATE INDEX idx_assistant_pending_batch ON assistant_pending_writes(batch_id, seq);
DROP INDEX idx_herald_pending_thread;
CREATE INDEX idx_assistant_pending_thread ON assistant_pending_writes(document_type, document_id, status);
DROP INDEX idx_herald_models_provider;
CREATE INDEX idx_assistant_models_provider ON assistant_models(provider_id);
DROP INDEX idx_herald_models_provider_priority;
CREATE UNIQUE INDEX idx_assistant_models_provider_priority ON assistant_models(provider_id, priority);

-- 3. assistant_settings rebuild — SQLite cannot ALTER a CHECK, and the engine
--    value must become 'assistant'. The old CHECK rejects 'assistant', so the
--    value is mapped during the copy (CASE), never UPDATEd in place.
CREATE TABLE "assistant_settings" (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  search_provider TEXT,
  search_api_key TEXT,
  url_allowlist TEXT,
  engine TEXT NOT NULL DEFAULT 'assistant' CHECK (engine IN ('assistant','blacksmith')),
  engine_switcher_enabled INTEGER NOT NULL DEFAULT 0,
  primary_supports_images INTEGER NOT NULL DEFAULT 0,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('minimal','low','medium','high')),
  write_tools TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  fallback_model_ids TEXT NOT NULL DEFAULT '[]',
  provider_id TEXT REFERENCES assistant_providers(id) ON DELETE SET NULL,
  primary_model_id TEXT
);
INSERT INTO assistant_settings (project_id, search_provider, search_api_key, url_allowlist, engine,
  engine_switcher_enabled, primary_supports_images, reasoning_effort, write_tools,
  created_at, updated_at, fallback_model_ids, provider_id, primary_model_id)
  SELECT project_id, search_provider, search_api_key, url_allowlist,
         CASE WHEN engine = 'herald' THEN 'assistant' ELSE engine END,
         engine_switcher_enabled, primary_supports_images, reasoning_effort, write_tools,
         created_at, updated_at, fallback_model_ids, provider_id, primary_model_id
  FROM herald_settings;
DROP TABLE herald_settings;

-- 4. value UPDATEs (neither column has a CHECK)
UPDATE runtime_tasks SET kind = 'assistant' WHERE kind = 'herald';
UPDATE project_memory SET source = 'assistant' WHERE source = 'herald';

-- 5. via_herald -> via_assistant (rebuild; D1 has no RENAME COLUMN).
--    Leaf tables: no inbound FKs; outbound FKs recreated in the DDL.
CREATE TABLE task_comments_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_kind  TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user','agent','system')),
  author_label TEXT NOT NULL,
  body         TEXT NOT NULL,
  edited_at    TEXT,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  via_assistant INTEGER NOT NULL DEFAULT 0
);
INSERT INTO task_comments_new (id, task_id, author_id, author_kind, author_label, body,
  edited_at, deleted_at, created_at, via_assistant)
  SELECT id, task_id, author_id, author_kind, author_label, body,
         edited_at, deleted_at, created_at, via_herald
  FROM task_comments;
-- carry the AUTOINCREMENT high-water mark; re-key after the rename
UPDATE sqlite_sequence
  SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'task_comments'), seq)
  WHERE name = 'task_comments_new';
DROP TABLE task_comments;
ALTER TABLE task_comments_new RENAME TO task_comments;
UPDATE sqlite_sequence SET name = 'task_comments' WHERE name = 'task_comments_new';
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);

CREATE TABLE task_activity_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_label   TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,
  message       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  via_assistant  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO task_activity_new (id, task_id, actor_kind, actor_label, actor_user_id, type,
  message, created_at, via_assistant)
  SELECT id, task_id, actor_kind, actor_label, actor_user_id, type,
         message, created_at, via_herald
  FROM task_activity;
UPDATE sqlite_sequence
  SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'task_activity'), seq)
  WHERE name = 'task_activity_new';
DROP TABLE task_activity;
ALTER TABLE task_activity_new RENAME TO task_activity;
UPDATE sqlite_sequence SET name = 'task_activity' WHERE name = 'task_activity_new';
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);

-- 6. agent-id rebind, FK-safe under an enforcing runner. The new display name
--    ("Assistant Agent") differs from the old ("Herald Agent"), so no
--    UNIQUE-name suffix dance is needed; `instructions` carries the persona.
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin, created_at, updated_at)
  SELECT 'assistant', 'Assistant Agent', description,
         REPLACE(instructions, 'Herald Agent', 'Assistant Agent'),
         is_builtin, created_at, updated_at
  FROM lexa_agents WHERE id = 'herald';

UPDATE runtime_tasks     SET agent_id = 'assistant' WHERE agent_id = 'herald';
UPDATE runtime_sessions  SET agent_id = 'assistant' WHERE agent_id = 'herald';
UPDATE lexa_agent_skills SET agent_id = 'assistant' WHERE agent_id = 'herald';
UPDATE assistant_threads  SET agent_id = 'assistant' WHERE agent_id = 'herald';

DELETE FROM lexa_agents WHERE id = 'herald';

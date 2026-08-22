-- Chat upgrades: pinning + list index that orders pinned threads first.
-- Replaces idx_herald_threads_chat_owner (same prefix, adds pinned DESC).

ALTER TABLE herald_threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_herald_threads_chat_owner;

CREATE INDEX idx_herald_threads_chat_list ON herald_threads(project_id, owner_user_id, pinned DESC, updated_at DESC)
  WHERE document_type = 'chat';

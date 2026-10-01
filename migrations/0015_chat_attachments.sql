-- 0015: chat attachments — temporary conversation context, NOT project artifacts.
-- One ADDITIVE table (no rebuild of `attachments`).
--
-- A chat attachment row is bound to its conversation thread via the composite
-- FK (document_type, document_id) → assistant_threads(document_type, document_id)
-- with ON DELETE CASCADE, so it dies with the thread. It is deliberately a
-- separate table from `attachments`: chat rows are per-thread context, never
-- listed in a project's attachment surface, never emit task_activity rows, and
-- carry no per-project dedupe. `mime_type` is SERVER-SNIFFED at upload (magic
-- bytes; text is UTF-8-probed) — the client-declared content type is never
-- trusted or stored. `storage_key` stays content-addressed ("blobs/<sha256>"),
-- so a blob shared with a task/wiki attachment is kept until the LAST
-- referencing row across BOTH tables goes (refcount at delete time).
--
-- The Bun migration runner disables foreign_keys for the run, so the cascade
-- does not fire there; the app deletes thread attachment rows explicitly (and
-- best-effort blobs) alongside the thread delete. Orphan blobs remain possible
-- and harmless, as with `attachments`.
CREATE TABLE chat_attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_type, document_id) REFERENCES assistant_threads(document_type, document_id) ON DELETE CASCADE
);
CREATE INDEX idx_chat_attachments_thread ON chat_attachments(document_type, document_id);
CREATE INDEX idx_chat_attachments_storage_key ON chat_attachments(storage_key);
CREATE INDEX idx_chat_attachments_project ON chat_attachments(project_id);

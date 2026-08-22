CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  wiki_page_id  TEXT REFERENCES wiki_pages(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((task_id IS NULL) != (wiki_page_id IS NULL)),
  UNIQUE(project_id, sha256)
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_wiki_page ON attachments(wiki_page_id);
CREATE INDEX idx_attachments_storage_key ON attachments(storage_key);

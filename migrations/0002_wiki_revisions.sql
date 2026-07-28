-- ============================================================
-- Wiki Page Revisions
-- Each row is a snapshot saved when a wiki page is updated.
-- ============================================================
CREATE TABLE wiki_page_revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_text TEXT NOT NULL DEFAULT '',
  save_type    TEXT NOT NULL CHECK (save_type IN ('autosave', 'manual')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_revisions_page ON wiki_page_revisions(page_id, created_at DESC);

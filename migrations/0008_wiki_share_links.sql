CREATE TABLE wiki_share_links (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wiki_share_links_page ON wiki_share_links(page_id);

-- 0030_markdown_documents.sql
-- Schema/defaults only. Never converts stored document bodies during boot.
CREATE TABLE _markdown_migration (
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  PRIMARY KEY (table_name, row_key)
);

INSERT OR IGNORE INTO settings (key, value)
SELECT 'documents.format', CASE
  WHEN EXISTS (SELECT 1 FROM tasks)
    OR EXISTS (SELECT 1 FROM task_comments)
    OR EXISTS (SELECT 1 FROM wiki_pages)
    OR EXISTS (SELECT 1 FROM wiki_page_revisions)
    OR EXISTS (SELECT 1 FROM assistant_pending_writes WHERE status = 'pending')
  THEN 'tiptap-v1'
  ELSE 'markdown-v1'
END;

-- Shadow columns preserve legacy bytes while changing only the default. D1's
-- supported DROP/RENAME COLUMN path avoids rebuilding parent tables/FKs.
ALTER TABLE tasks ADD COLUMN description_markdown TEXT NOT NULL DEFAULT '';
UPDATE tasks SET description_markdown = description;
ALTER TABLE tasks DROP COLUMN description;
ALTER TABLE tasks RENAME COLUMN description_markdown TO description;

ALTER TABLE wiki_pages ADD COLUMN content_markdown TEXT NOT NULL DEFAULT '';
UPDATE wiki_pages SET content_markdown = content;
ALTER TABLE wiki_pages DROP COLUMN content;
ALTER TABLE wiki_pages RENAME COLUMN content_markdown TO content;

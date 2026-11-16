CREATE TABLE assistant_embeddings (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('wiki','task','memory')),
  ref_id           TEXT NOT NULL,            -- wiki_pages.id | tasks.id | project_memory.id
  chunk_index      INTEGER NOT NULL,
  content          TEXT NOT NULL,            -- text fed to the embedder (title-prefixed)
  embedding        BLOB,                     -- float32[768] little-endian, NULL until embedded
  embedding_model  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ref_id, chunk_index)
);
CREATE INDEX idx_assistant_embeddings_project
  ON assistant_embeddings (project_id, kind) WHERE embedding IS NOT NULL;

-- Orphan cleanup, mirroring the wiki_fts trigger pattern:
CREATE TRIGGER assistant_embeddings_wiki_delete AFTER DELETE ON wiki_pages BEGIN
  DELETE FROM assistant_embeddings WHERE kind = 'wiki' AND ref_id = OLD.id;
END;

CREATE TRIGGER assistant_embeddings_task_delete AFTER DELETE ON tasks BEGIN
  DELETE FROM assistant_embeddings WHERE kind = 'task' AND ref_id = OLD.id;
END;

CREATE TRIGGER assistant_embeddings_memory_delete AFTER DELETE ON project_memory BEGIN
  DELETE FROM assistant_embeddings WHERE kind = 'memory' AND ref_id = OLD.id;
END;

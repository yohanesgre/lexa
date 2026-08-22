-- Multi-thread chat history: per-thread titles + owner-scoped list index.

ALTER TABLE herald_threads ADD COLUMN title TEXT;

CREATE INDEX idx_herald_threads_chat_owner ON herald_threads(project_id, owner_user_id, updated_at DESC)
  WHERE document_type = 'chat';

-- Backfill chat titles from the first text message (CRLF → space, ≤60 chars).
-- Image-array first messages have no text content and stay NULL until the
-- next send derives a title.
UPDATE herald_threads
SET title = substr(
  replace(replace(json_extract(messages, '$[0].content'), char(10), ' '), char(13), ' '),
  1,
  60
)
WHERE document_type = 'chat'
  AND json_type(messages, '$[0].content') = 'text';

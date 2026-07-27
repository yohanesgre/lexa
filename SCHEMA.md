# D1 Database Schema (v2 — post-review)

> Reviewed against REVIEW.md. Changes from v1: labels & subtasks cut (YAGNI), `column_policies` table replaced by `columns.required_fields`, `columns.github_state` added for sync mapping, `tasks.github_synced_state` for echo suppression, `UNIQUE(github_issue_id)`, `UNIQUE(column_id, position)` for fractional-index integrity, FTS5 for wiki search, `webhook_events` dedup table, consolidated indexes.

## Full Schema

```sql
-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,                              -- UUID (crypto.randomUUID())
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,                          -- duplicate → SlugTaken 409
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT,                                          -- "owner/repo"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))        -- maintained by app on every UPDATE
);

-- ============================================================
-- Kanban Columns
-- ============================================================
-- required_fields: JSON array of fields a task must have populated
--   before entering this column, e.g. '["description","assignee"]'.
--   Emptiness for "description" = TipTap doc with no text-bearing nodes.
-- github_state: maps this column to a GitHub issue state for sync.
--   Exactly one column per project should map to 'closed' (e.g. Done).
--   Renaming a column never breaks sync — the mapping is explicit.
CREATE TABLE columns (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,                          -- no UNIQUE: ties are harmless,
                                                             -- and UNIQUE makes reorder painful
  color           TEXT NOT NULL DEFAULT '#6b7280',
  wip_limit       INTEGER,                                   -- NULL = no limit
  required_fields TEXT NOT NULL DEFAULT '[]',
  github_state    TEXT CHECK (github_state IN ('open','closed'))
);

-- ============================================================
-- Swimlanes (horizontal grouping)
-- ============================================================
CREATE TABLE swimlanes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL
);

-- ============================================================
-- Tasks (the core entity)
-- ============================================================
-- position: fractional-index key (see Design Notes). UNIQUE(column_id, position)
--   turns a concurrent-create race into a constraint violation → app retries
--   with a freshly generated key.
-- github_issue_id UNIQUE: one task ↔ one GitHub issue, enforced.
-- github_synced_state: last KNOWN issue state — set both when we push to
--   GitHub AND when we process a GitHub-originated webhook. The webhook
--   handler compares payload state against this; equal → echo → skip.
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id           TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
                                                            -- deleting non-empty column → ColumnNotEmpty 409
  swimlane_id         TEXT REFERENCES swimlanes(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '{}',            -- TipTap JSON
  priority            TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('urgent','high','medium','low')),
  type                TEXT NOT NULL DEFAULT 'task'
                        CHECK (type IN ('feature','bug','task','asset')),
  assignee            TEXT,                                  -- freeform string; no users table
  position            TEXT NOT NULL,                         -- fractional-index key
  github_issue_id     TEXT UNIQUE,                           -- GitHub node_id; one task ↔ one issue
  github_issue_number INTEGER,
  github_repo         TEXT,                                  -- "owner/name" captured at link time;
                                                             -- issue URL derived: github.com/<repo>/issues/<n>
  github_synced_state TEXT CHECK (github_synced_state IN ('open','closed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),  -- maintained by app
  UNIQUE(column_id, position)
);

-- ============================================================
-- Wiki Pages (nested, TipTap content)
-- ============================================================
-- parent_id ON DELETE RESTRICT: deleting a page with children fails
--   (ColumnNotEmpty-style 409) — forces explicit move/delete of children.
--   (v1 used SET NULL which silently re-rooted children to top level.)
-- content_text: plain-text projection of `content`, maintained by the app
--   on every write. Backs FTS5 so search indexes real text, not JSON syntax.
CREATE TABLE wiki_pages (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '{}',                   -- TipTap JSON
  content_text TEXT NOT NULL DEFAULT '',                     -- app-maintained plain text
  parent_id    TEXT REFERENCES wiki_pages(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL DEFAULT 0,                   -- ordering within siblings
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

-- FTS5 external-content table for wiki search (MCP search_wiki tool).
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  title,
  content_text,
  content='wiki_pages',
  content_rowid='rowid'
);

CREATE TRIGGER wiki_fts_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER wiki_fts_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
END;

CREATE TRIGGER wiki_fts_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
  VALUES ('delete', old.rowid, old.title, old.content_text);
  INSERT INTO wiki_fts(rowid, title, content_text)
  VALUES (new.rowid, new.title, new.content_text);
END;

-- ============================================================
-- API Keys (MCP / Hermes auth)
-- ============================================================
-- Raw key format: "lxk_" + base62(32 random bytes) — high entropy by
-- construction, so unsalted SHA-256 of the raw key is a sound storage hash.
-- key_hash UNIQUE also serves as the lookup index.
-- last_used_at: updated only when NULL or older than 1 hour (sampled,
--   avoids a D1 write on every MCP call).
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                                -- "hermes", "opencode-local"
  key_hash     TEXT NOT NULL UNIQUE,                         -- hex(SHA-256(raw key))
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- ============================================================
-- Webhook event dedup (GitHub delivers at-least-once)
-- ============================================================
-- INSERT OR IGNORE on X-GitHub-Delivery; if a row already exists the
-- event is a duplicate delivery → skip processing.
CREATE TABLE webhook_events (
  delivery_id TEXT PRIMARY KEY,                              -- X-GitHub-Delivery header
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes
-- ============================================================
-- Board fetch = WHERE project_id=? ORDER BY column, position → one index.
CREATE INDEX idx_tasks_board     ON tasks(project_id, column_id, position);
CREATE INDEX idx_tasks_swimlane  ON tasks(project_id, swimlane_id);
CREATE INDEX idx_columns_project ON columns(project_id, position);
CREATE INDEX idx_swimlanes_proj  ON swimlanes(project_id, position);
CREATE INDEX idx_wiki_project    ON wiki_pages(project_id);
CREATE INDEX idx_wiki_parent     ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;
-- tasks.github_issue_id and api_keys.key_hash are indexed by their UNIQUE constraints.
```

## Design Notes

### Fractional indexing — use the library, not a hand-rolled scheme
`tasks.position` uses the `fractional-indexing` npm package (Workers-safe, ~2KB). The library exports `generateKeyBetween(a, b)` and `generateNKeysBetween(a, b, n)` only — define wrappers: `generateKeyAfter(x) = generateKeyBetween(x, null)`, `generateKeyBefore(x) = generateKeyBetween(null, x)`.

Key generation is **deterministic** — regenerating with the same inputs yields the same key. Every retry path must therefore RE-READ the anchor rows before regenerating (the concurrent winner's row is now visible). The retry fires only on the `UNIQUE(column_id, position)` violation — never on FK/NOT NULL failures. At most one retry, then surface the error.

- **Create:** read last key in column → `generateKeyAfter(last)` → insert. On position conflict: re-read last, regenerate, insert.
- **Move with neighbors** (`beforeTaskId`/`afterTaskId` given): read both neighbors (validated to be in the TARGET column of the same project) → `generateKeyBetween(before, after)`. Position is always reassigned on move — never carried over from the source column.
- **Move without neighbors** (webhook moves, drop-on-empty-zone): default placement = append to end — read last key in target column → `generateKeyAfter(last)`. **Never** call `generateKeyBetween(null, null)` for a non-empty column: it returns `"a0"`, which collides with the column's first task.
- **Move race safety:** same discipline as create — on position conflict, re-read the anchors (neighbors or last), regenerate, retry once. Create and move share this rule.

### Atomic WIP-limit enforcement
Count-check-then-update is racy. The move is a single conditional statement:

```sql
UPDATE tasks
SET column_id = ?2,
    swimlane_id = ?3,          -- omitted in payload → app passes current value; explicit NULL → clear
    position = ?4,
    updated_at = datetime('now')
WHERE id = ?1
  AND (
    column_id = ?2             -- within-column reorder: count unchanged → skip WIP check
    OR (SELECT COUNT(*) FROM tasks WHERE project_id = ?5 AND column_id = ?2)
       < COALESCE((SELECT wip_limit FROM columns WHERE id = ?2), 9223372036854775807)
  );
```

`rowsChanged = 0` after confirming the task exists → `WipLimitExceeded` (409). Webhook-driven moves use a separate statement without the count clause (robots bypass WIP limits — see LAYERS.md).

- The `column_id = ?2` short-circuit prevents false `WipLimitExceeded` on pure reorders inside an at-limit column (the moving task would otherwise count itself).
- Count and last-key queries include `project_id` so `idx_tasks_board` (leftmost `project_id`) applies.
- Swimlane semantics: payload omits `swimlaneId` → keep current value; explicit `null` → clear the lane.

### Echo suppression (`github_synced_state`)
Every Lexa→GitHub state sync writes the state we pushed. The webhook handler compares the payload's issue state against `github_synced_state`: equal → our own echo → skip (and update `received_at` only). Without this, every move triggers a self-reinforcing webhook storm.

### One task ↔ one issue
`UNIQUE(github_issue_id)` + an already-linked guard in the service prevents duplicate issue creation and ambiguous webhook lookups (`findByGithubIssue` always returns ≤1 row).

### FTS5 for `search_wiki`
The `wiki_fts` external-content table + triggers keep the index in sync automatically. The app maintains `content_text` (plain-text projection of TipTap JSON) on every wiki write — searching raw TipTap JSON would match syntax tokens, not words.

### `updated_at` is app-maintained
Every repo `update*` method sets `updated_at = datetime('now')` in the same statement. No triggers — the write path is already centralized in repositories.

### No multi-statement ACID needed
Every mutation is either a single statement or a D1 `batch()` (atomic all-or-nothing). The one multi-write flow (move + update synced state) is a batch.

### D1 notes (unchanged from v1)
- TEXT UUIDs via `crypto.randomUUID()` in Workers.
- D1 is eventually read-replicated — frontend must update its cache from mutation responses (TanStack Query `setQueryData`), not refetch, or cards visually snap back.
- 100KB row limit: fine for TipTap docs at this scale.
- `webhook_events` grows unboundedly → periodic prune (`DELETE WHERE received_at < datetime('now','-7 days')`) via a Cron Trigger.

## Cut from v1 (YAGNI — see REVIEW.md 🟢)

| Cut | Replacement |
|-----|-------------|
| `labels` + `task_labels` tables, 3 routes, 2 MCP tools | `tasks.type` (feature/bug/task/asset) covers game-dev categorization |
| `tasks.parent_id` (subtasks) | Flat tasks; breakdown lives in the TipTap description checklist |
| `column_policies` table (3 rule types) | `columns.required_fields` JSON array — the only enforceable policy without a roles system or column-entry timestamps |

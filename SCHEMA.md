# SQLite Schema (v2 — post-review)

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
--   Emptiness for "assignee" = task_assignees has no rows for this task.
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
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL
);

-- ============================================================
-- Task field options (per-project customizable priority/type)
-- ============================================================
-- Each project owns ordered option lists for the two task fields.
-- tasks.priority / tasks.type reference these IDs (no CHECK enums).
-- position: integer ordering; the FIRST option (position 0) is the
--   create default. Delete is blocked while any task uses the option.
CREATE TABLE priority_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);
CREATE INDEX idx_priority_options_project ON priority_options(project_id, position);

CREATE TABLE type_options (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  position    INTEGER NOT NULL,
  UNIQUE(project_id, label)
);
CREATE INDEX idx_type_options_project ON type_options(project_id, position);

-- ============================================================
-- Tasks (the core entity)
-- ============================================================
-- position: fractional-index key (see Design Notes). UNIQUE(column_id, position)
--   turns a concurrent-create race into a constraint violation → app retries
--   with a freshly generated key.
-- GitHub issues are stored in the task_github_issues junction table (multi-issue).
-- The old inline columns (github_issue_id, github_issue_number, github_repo,
--   github_synced_state) still exist on the tasks table but are unused — SQLite's
--   DROP COLUMN (3.35+) could remove them, but they are harmless and left in place.
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id           TEXT NOT NULL REFERENCES columns(id) ON DELETE RESTRICT,
                                                            -- deleting non-empty column → ColumnNotEmpty 409
  swimlane_id         TEXT NOT NULL REFERENCES swimlanes(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '{}',            -- TipTap JSON
  priority            TEXT NOT NULL REFERENCES priority_options(id),
  type                TEXT NOT NULL REFERENCES type_options(id),
  position            TEXT NOT NULL,                         -- fractional-index key
  archived_at         TEXT,                                   -- NULL = live; set to datetime('now') on archive
                                                              -- archived tasks keep column/position and are excluded
                                                              -- from board/WIP/count queries unless includeArchived
  github_issue_id     TEXT UNIQUE,                           -- DEPRECATED — now in task_github_issues
  github_issue_number INTEGER,                              -- DEPRECATED
  github_repo         TEXT,                                  -- DEPRECATED
  github_synced_state TEXT CHECK (github_synced_state IN ('open','closed')), -- DEPRECATED
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),  -- maintained by app
  UNIQUE(column_id, position)
);

-- ============================================================
-- Task GitHub Issues (multi-issue junction table)
-- ============================================================
-- One task can be linked to multiple GitHub issues (across repos).
-- synced_state: echo suppression per-link — the webhook handler compares the
--   payload state against this value; equal → skip. Different from column's
--   githubState → outOfSync displayed in UI.
CREATE TABLE task_github_issues (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL,                              -- GitHub node_id
  issue_number  INTEGER NOT NULL,
  repo          TEXT NOT NULL,                              -- "owner/name"
  synced_state  TEXT CHECK (synced_state IN ('open','closed')),
  PRIMARY KEY (task_id, issue_id)
);

-- ============================================================
-- Task Assignees (multi-assignee junction table)
-- ============================================================
-- Replaces the old tasks.assignee TEXT column (single string).
-- Stacked avatars on kanban cards render up to 3 + overflow count.
CREATE TABLE task_assignees (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  PRIMARY KEY (task_id, user_name)
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
-- Wiki Page Revisions
-- ============================================================
CREATE TABLE wiki_page_revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL,                              -- TipTap JSON
  content_text TEXT NOT NULL DEFAULT '',                   -- plain text snapshot
  save_type    TEXT NOT NULL CHECK (save_type IN ('autosave', 'manual')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_revisions_page ON wiki_page_revisions(page_id, created_at DESC);

-- ============================================================
-- API Keys (MCP / Hermes auth)
-- ============================================================
-- Raw key format: "lxk_" + base62(32 random bytes) — high entropy by
-- construction, so unsalted SHA-256 of the raw key is a sound storage hash.
-- key_hash UNIQUE also serves as the lookup index.
-- last_used_at: updated only when NULL or older than 1 hour (sampled,
--   avoids a SQLite write on every MCP call).
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

### Task field options (custom priority/type)
Priority and type are per-project option lists (`priority_options` / `type_options`), not global enums. Tasks reference option IDs via `tasks.priority` / `tasks.type` (FK to the option tables; SQLite enforces membership).

- **Order** = `position` ascending; the first option (position 0) is the create default.
- **Backfill:** migration `0010` creates both tables, seeds the legacy 4+4 options per existing project, then rewrites `tasks.priority` / `tasks.type` to the matching option IDs. New projects get their option rows seeded at creation (ProjectService).
- **Delete rule:** an option used by any task cannot be deleted (`OptionInUse` 409). Reassign or delete the tasks first.
- **Validation:** create/update task payloads carry option IDs; services validate the ID belongs to the task's project (`InvalidOption` 422).
- **Dashboard urgency:** `countUrgent` / `findUrgentAcrossAllProjects` use a project's first priority option (position 0) as the "urgent" equivalent. If a team reorders so a different option leads, urgency follows the new default.

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
    swimlane_id = ?3,          -- required — every task must belong to a swimlane
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
- Every task must belong to both a column and a swimlane. Columns are templates rendered inside swimlane rows. New projects get a default "Default" swimlane.
- **WIP limit is per-column total** — counts ALL tasks in the column across all swimlanes. The WIP badge in each swimlane row shows the same total, not per-swimlane count.

### Echo suppression (`synced_state`)
Every Lexa→GitHub state sync writes the state we pushed to `task_github_issues.synced_state` for that specific issue. The webhook handler compares the payload's issue state against `synced_state`: equal → our own echo → skip. Without this, every move triggers a self-reinforcing webhook storm.

### One task ↔ many issues
Multiple GitHub issues can link to one task. Each link has its own `synced_state` for per-issue echo suppression. The webhook looks up by `issue_id` in `task_github_issues` to find the task.

### FTS5 for `search_wiki`
The `wiki_fts` external-content table + triggers keep the index in sync automatically. The app maintains `content_text` (plain-text projection of TipTap JSON) on every wiki write — searching raw TipTap JSON would match syntax tokens, not words.

### `updated_at` is app-maintained
Every repo `update*` method sets `updated_at = datetime('now')` in the same statement. No triggers — the write path is already centralized in repositories.

### No multi-statement ACID needed
Every mutation is either a single statement or a SQLite transaction (`server/db/database.ts` `batch()` helper — `db.transaction()` wrapping prepared statements, atomic all-or-nothing). The one multi-write flow (move + update synced state) runs through `batch()`.

### SQLite notes (unchanged from v1)
- TEXT UUIDs via `crypto.randomUUID()` in Bun.
- SQLite is local (WAL) — reads are immediate. Frontend still updates its cache from mutation responses (TanStack Query `setQueryData`), not refetch, because the mutation response is the authoritative state.
- No row-size limits at this scale: fine for TipTap docs.
- `webhook_events` grows unboundedly → periodic prune (`DELETE WHERE received_at < datetime('now','-7 days')`) on a timer or at boot.

## Cut from v1 (YAGNI — see REVIEW.md 🟢)

| Cut | Replacement |
|-----|-------------|
| `labels` + `task_labels` tables, 3 routes, 2 MCP tools | `type_options` (customizable per-project task types) covers game-dev categorization |
| `tasks.parent_id` (subtasks) | Flat tasks; breakdown lives in the TipTap description checklist |
| `column_policies` table (3 rule types) | `columns.required_fields` JSON array — the only enforceable policy without a roles system or column-entry timestamps |

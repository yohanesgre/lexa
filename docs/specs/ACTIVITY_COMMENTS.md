# Task Activity Timeline + Comments — Design Spec

Status: **Approved (all sections)** · Date: 2026-08-08 · Viz: `docs/lexa-activity-plan.html`

**IMPLEMENTED** (2026-08-08, plan `2026-08-08-activity-comments`, tasks 1–18). Implementation notes / divergences:
- **Event catalog divergence (user decision):** `forge_accepted` / `forge_rejected` were DROPPED — accept is client-side only, no server hook. The shipped 18-value `ActivityType` union omits them; the catalog line below is amended accordingly.
- The invariant is "one row per meaningful change" — updates emit one `field_changed` row PER changed field (several rows for a multi-field update), not "exactly one row" per mutation as the original line below says.
- Authz note (user ruling): delete = author OR project admin, but under current REST plumbing every key is admin — any key holder may delete any comment (see ARCHITECTURE.md decisions log #14).

Reverses the v1 "comments-free" cut (`RELEASE_NOTES.md`, `ARCHITECTURE.md`). Drivers: missing context trail ("what happened here?"), discussion surface for a team that outgrew description-only breakdowns, and agent visibility (MCP/Forge leave a trace and read context). Comments stay in Lexa — no GitHub sync.

## Decisions (all confirmed with user)

| Decision | Choice |
|---|---|
| Structure | Unified activity timeline — comments + system events interleaved (GitHub issue-timeline style) |
| Approach | A — append-only rows emitted by services, message frozen at write time |
| Comment format | TipTap JSON (same model as `tasks.description`) |
| Comment capabilities | Author edit (edited marker, no revision history) + author/admin delete |
| Mentions | `@name` highlight only at render time — no delivery, no notifications |
| Event detail | Simple human-readable messages, no before/after storage |
| Event coverage | Full — every task mutation + Forge terminal/review states |
| GitHub | No comment sync; GitHub-driven state changes still appear in the timeline |
| MCP | Read activity + add comments (Markdown at the boundary), attributed by API key name |
| Ids | `INTEGER PRIMARY KEY` (rowid) on both new tables — second-granularity `created_at` ties are common; random UUIDs don't order chronologically |
| Retention | Never prune (contrast: `webhook_events` 7-day prune — deliberate) |

## Schema (SCHEMA.md additions, next migration per `server/db/migrations/` numbering)

```sql
CREATE TABLE task_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL: agent/system
  author_kind  TEXT NOT NULL DEFAULT 'user'
               CHECK (author_kind IN ('user','agent','system')),
  author_label TEXT NOT NULL,        -- frozen at write time (task_assignees.user_name pattern)
  body         TEXT NOT NULL,        -- TipTap JSON doc
  edited_at    TEXT,                 -- set on edit → "edited" marker
  deleted_at   TEXT,                 -- soft delete → hidden from timeline
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);

CREATE TABLE task_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_label   TEXT NOT NULL,         -- frozen display name
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                                        -- agent: key owner; user: their id; NULL: unbound key / system
  type          TEXT NOT NULL,         -- enum in shared/types.ts (no CHECK — growing set)
  message       TEXT NOT NULL,         -- frozen at write time; the record
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);
```

- Backfill: one `created` row per existing task (from `tasks.created_at`); archived tasks also get an `archived` row (from `tasks.archived_at`).
- Task delete cascades comments + activity — consistent with existing hard delete (deliberate).
- `comment body` ≤ 64KB, must be a non-empty TipTap doc (invariant #11 emptiness check).

## Actor model

Resolved at the boundary; services receive `actor: Actor {kind, label, userId?}` as a parameter.

**Attribution ≠ authorization.** A bound MCP key authorizes with the owner's permissions but is attributed as the agent — the trace says "opencode-local moved…", never "Maria moved…"; `actor_user_id` records whose key drove it (UI hint: "opencode-local (Maria's key)").

| Surface | kind | label | actor_user_id |
|---|---|---|---|
| Browser (Cf-Access) | `user` | `users.name` (auth.ts) | user id |
| MCP — bound key (`api_keys.user_id` set) | `agent` | API key name | key owner id |
| MCP — unbound key | `agent` | API key name | NULL |
| GitHub webhook | `system` | `github` | NULL |
| Forge daemon | `agent` | runtime agent name | daemon key owner (if bound) |
| Migration backfill | `system` | `system` | NULL |

Comment authz keys off `author_kind='user'` + acting user — agents never hold edit/delete rights (they get no comment tools anyway).

## Services (LAYERS.md additions)

- **ActivityService** (leaf — never depends on TaskService): `append(taskId, actor, type, message)`, `listMerged(taskId, cursor, limit)`.
- **CommentService**: create/edit/delete + authz. Uses TaskRepo (existence) + ActivityService. No TaskService dependency → no cycle.
- **TaskService**: every mutating method appends activity **in the same transaction** (`batch()`) — create, update, move (incl. webhook `bypassGuards` path), archive, restore, delete, links, sources, github link/unlink.
- **ForgeService**: emits on terminal state (`forge_completed` / failed / cancelled). (Result accept/reject dropped — client-side only, no server hook.)

**New invariant:** every task mutation appends `task_activity` row(s) in the same transaction as the mutation — one row per meaningful change (updates may emit several `field_changed` rows); position-only reorders emit nothing; webhook moves emit `github_synced` only.

## REST (API.md additions)

```
GET    /api/projects/:slug/tasks/:id/activity?cursor&limit
       → 200 { data: ActivityItem[], nextCursor }
       Item = { kind:'event', id, type, actorKind, actorLabel, actorUserId, message, createdAt }
            | { kind:'comment', id, authorKind, authorLabel, authorUserId, body: TipTapDoc,
                editedAt, createdAt }

POST   /api/projects/:slug/tasks/:id/comments     { body: TipTapDoc }
       → 201 { data: { comment, activity } }      # activity = 'commented' row

PATCH  /api/projects/:slug/tasks/:id/comments/:commentId   { body }
       → 200 { data: Comment }                    # sets edited_at; no activity row (marker only)

DELETE /api/projects/:slug/tasks/:id/comments/:commentId
       → 204                                      # soft delete + 'comment_deleted' row
```

- Pagination: keyset `(created_at, rowid)` per table, in-memory merge of two bounded sets, slice to limit. Cursor encodes `created_at|rowid|kind`. Read query: `WHERE task_id=? AND id<? ORDER BY id DESC LIMIT ?`.
- Authz: edit = author only; delete = author or project admin (`users.role='admin'` or admin `user_project_roles` row).
- Errors: `COMMENT_NOT_FOUND` 404 · `COMMENT_EDIT_FORBIDDEN` 403 · `COMMENT_DELETE_FORBIDDEN` 403 · `COMMENT_INVALID` 422.
- **Response envelope rule (invariant #6):** all task mutation responses include `activity?: ActivityEvent[]` (rows appended by that mutation). Client prepends via `setQueryData`; never `invalidateQueries` on the mutation path. Webhook-driven entries appear on next slideover open (documented).

## MCP (MCP.md additions)

- `get_task_activity` `{ taskId }` → `{ activity: [{ type, actor, at, message, comment?: { markdown } }], nextCursor? }` — `docToMarkdown` at the boundary.
- `add_task_comment` `{ taskId, comment: Markdown }` → created comment (Markdown) — `markdownToDoc` at the boundary.
- No edit/delete tools for agents. Errors: `TASK_NOT_FOUND`, `COMMENT_INVALID`.

## Event catalog

`created` · `moved` (column/lane) · `field_changed` (title/description/priority/type/assignees — no diffs) · `archived` · `restored` · `deleted` · `link_added` · `link_removed` · `source_added` · `source_removed` · `github_linked` · `github_unlinked` · `github_synced` (webhook-driven) · `forge_completed` · `forge_failed` · `forge_cancelled` · `commented` · `comment_deleted`.

> ~~`forge_accepted` · `forge_rejected`~~ — dropped by user decision (accept is client-side, no server hook).

Messages frozen at write time (e.g. `"Maria moved from In Progress to Done"`). Column renamed later → old messages keep the old name (by design).

## Frontend (wireframe-first — P0)

- Slideover gains a tab bar: **Description | Activity**. Existing content = Description tab; timeline = Activity tab.
- Timeline: event rows (muted text, time, type icon dot) + comment cards (author chip/avatar, TipTap body, `edited` marker, author edit/delete, admin delete). "Load older" cursor button. Empty state: "No activity yet — be the first to comment".
- **Step rail** (wireframe `task-detail.html`): timeline renders as a vertical step rail — one continuous 2px line (`--lx-border-subtle`) connecting step markers: event rows use their type-colored dot (robot glyph for agent, GitHub icon for webhook), comment cards use the author avatar; all markers share one 24px rail column, line starts at first marker center (no segment above) and ends at last marker center (no dangling tail). "Load older" prepends entries onto the rail (rail start moves, line never breaks). Empty state: box replaces the timeline, no rail. Hover: row highlight + marker brighten. Implementation note: rail bounds must be derived from marker positions at render, not hardcoded.
- Composer at tab bottom: existing TipTap editor + toolbar partial. Archived tasks: view-only timeline, no composer.
- Mention highlight: render-time regex over project member names in comment text nodes → chip. Unknown names render plain. No delivery.
- **XSS rule:** event messages render as plain text nodes, never HTML.
- Cache: query key `['project', slug, 'task', id, 'activity']`; mutations prepend responses; affordances hidden for non-authors; toasts on 403/422.

## Edge cases (designed)

Renamed columns keep frozen names · deleted users keep frozen labels · deleted tasks cascade (documented) · same-second events ordered by rowid · archived-task backfill includes `archived` · webhook events on next open · empty/malformed/oversized body → 422.

## Non-goals

No GitHub comment sync · no notifications/email · no FTS over comments · no comment revision history · no admin edit · no reactions/pinning · no cross-project activity view · no realtime push.

## Implementation phases

| Phase | Scope | Gate |
|---|---|---|
| P0 | Wireframes: Activity tab in `task-detail.html` + annotations, `build.sh` | build clean + tsc |
| P1 | Migration 00XX + backfill; `shared/types.ts` (ActivityType, ActivityEvent, Comment, Actor); SCHEMA.md | tsc + fresh-DB migration |
| P2 | ActivityRepo, CommentRepo, ActivityService, CommentService, actor resolution, emission points (TaskService, ForgeService, webhook path) | tsc + vitest |
| P3 | REST endpoints, error mapping, response envelope; API.md | backend curl suite |
| P4 | MCP tools; MCP.md | MCP handshake + smoke |
| P5 | Frontend per wireframe | tsc + browser pass (0 console errors) |
| P6 | Docs: LAYERS.md, AGENTS.md invariant, ARCHITECTURE.md log, RELEASE_NOTES.md; full acceptance | RELEASE.md checks |

# Lexa — Bespoke Project Management Tool (v2 — post-review)

> Updated against REVIEW.md (oracle review). All 🔴 blockers resolved, all 🟡 should-fix items applied, recommended 🟢 cuts made. Changes are summarized at the bottom of this doc and in the Decisions Log.

## Overview

A lightweight, self-hosted project management tool built for small game development teams (2–5 people). Kanban board, issue/task ticketing, nested wiki/docs, AI agent (MCP) access, and GitHub issue sync — running on a Bun standalone server with SQLite.

## Tech Stack

| Layer        | Choice                        | Rationale |
| ------------ | ----------------------------- | --------- |
| Frontend     | React + Vite + TanStack Start | SSR for initial load, SPA-like after, file-based routing |
| Backend      | Effect-TS + @effect/platform HttpApi | Typed errors, DI, declarative error→HTTP mapping, OpenAPI for free |
| Database     | SQLite via bun:sqlite (WAL)   | Local file, zero-ops, transactional batch helper for atomic mutations |
| Runtime      | Bun standalone HTTP server (Docker) | One process for SSR + REST + MCP + webhooks; simple deploys |
| Human auth   | Cloudflare Access (via cloudflared tunnel) | Zero auth code — email allowlist in CF dashboard, server reads identity header |
| Machine auth | API keys (`lxk_` + base62(32B)) | Hermes/MCP: Bearer key → SHA-256 lookup |
| MCP Server   | Built into the Bun server     | Streamable HTTP, stateless, shares Effect services with REST |
| GitHub Sync  | GitHub App + Webhooks         | Issues r/w + Metadata read only; echo-suppressed two-way state sync |
| Styling      | Tailwind                      | Fast, tree-shaken |
| Rich Text    | TipTap (ProseMirror)          | Structured JSON, React integration, MCP-friendly |
| Drag & Drop  | @dnd-kit                      | Accessible, works with fractional-index positions |
| Ordering     | `fractional-indexing` (npm)   | `generateKeyBetween` — correct, tiny, Workers-safe |

## Data Model

See SCHEMA.md for the full SQL. Conceptual view:

```
projects
├── id, name, slug (UNIQUE), description, github_repo ("owner/repo"), timestamps
│
columns (per project, ordered)
├── id, name, position, color, wip_limit
├── required_fields (JSON array — the only column policy)
└── github_state ('open'|'closed'|NULL — explicit sync mapping)
│
swimlanes (per project, ordered)
└── id, name, position
│
tasks
├── id, column_id, swimlane_id (nullable), project_id
├── title, description (TipTap JSON), priority, type (feature|bug|task|asset)
├── assignee (freeform string)
├── position (fractional-index key, UNIQUE per column)
├── github_issue_id (UNIQUE), github_issue_number, github_repo ("owner/name")
├── github_synced_state (last known issue state — echo suppression)
└── timestamps
│
wiki_pages (nested)
├── id, title, slug (UNIQUE per project), content (TipTap JSON)
├── content_text (plain text, backs FTS5 search)
├── parent_id (ON DELETE RESTRICT), position
└── timestamps
│
api_keys                        webhook_events
├── id, name, key_hash (SHA-256) ├── delivery_id (X-GitHub-Delivery, PK)
└── timestamps                   └── received_at (pruned >7 days via Cron)
```

**Cut from v1:** labels (2 tables, 3 routes, 2 MCP tools) — `tasks.type` covers game-dev categorization. Subtasks (`parent_id`) — flat tasks; breakdown lives in the description checklist. Column policies `restrict_roles`/`min_time` — unenforceable without roles/timestamps (see REVIEW.md 🔴 #5).

## Auth

### Humans → Cloudflare Access
The app hostname sits behind Cloudflare Access (via the cloudflared tunnel) with an email allowlist (or GitHub org policy) managed in the CF dashboard. The Bun server reads `Cf-Access-Authenticated-User-Email` from the tunneled request for identity (assignee suggestions, display). **No OAuth code, no sessions, no cookies, no CSRF surface, no auth routes.**

Two deployment rules make this sound (both mandatory):

1. **Serve only on the Access-protected hostname through the tunnel** — no public bypass. The tunnel is the only ingress; there is no `workers.dev` route to disable.
2. **Machine endpoints can't do Access's browser flow.** Add Access "bypass" policies scoped to `/mcp` and `/api/webhooks/*` — they authenticate via API key and HMAC signature respectively (both already designed). Optional alternative for Hermes: a CF service token.

### Machines → API keys
`Authorization: Bearer lxk_<base62(32 random bytes)>`. Server: `SHA-256(raw)` → `api_keys.key_hash` lookup. Keys are full read/write — **no scopes** (single-agent trust model, explicit). `last_used_at` updated only when NULL or stale >1h.

The webhook route is exempt from API-key middleware — it authenticates via `X-Hub-Signature-256` (HMAC-SHA-256 over the raw body, constant-time compare, verified before parsing).

## API Routes (REST)

All list endpoints paginate: `?limit` (default 50, max 200) + opaque cursor — **except `/board`**, which returns the complete board snapshot. Auth: Access header (humans) or Bearer key (machines); implemented as HttpApi middleware.

```
Projects          GET/POST            /api/projects
                  GET/PATCH/DELETE    /api/projects/:slug

Columns           GET/POST            /api/projects/:slug/columns
                  PATCH/DELETE        /api/projects/:slug/columns/:id
                                      (DELETE non-empty → 409 ColumnNotEmpty)

Swimlanes         GET/POST            /api/projects/:slug/swimlanes
                  PATCH/DELETE        /api/projects/:slug/swimlanes/:id

Tasks             GET/POST            /api/projects/:slug/tasks
                  GET/PATCH/DELETE    /api/projects/:slug/tasks/:id
                  POST                /api/projects/:slug/tasks/:id/move
                                      body: { columnId, swimlaneId?, beforeTaskId?, afterTaskId? }
                                      → ONE atomic op: column + lane + position
                                      swimlaneId omitted → keep current; explicit null → clear
                  GET                 /api/projects/:slug/board
                                      → full board snapshot (columns + swimlanes + ALL
                                        tasks), unpaginated — the kanban needs the
                                        complete project view

Wiki              GET/POST            /api/projects/:slug/wiki
                  GET/PATCH/DELETE    /api/projects/:slug/wiki/:pageSlug
                  GET                 /api/projects/:slug/wiki/:pageSlug/children
                  GET                 /api/projects/:slug/wiki/search?q=  (FTS5)

Webhooks          POST                /api/webhooks/github   (signature-verified, no API key)

Settings          GET/POST/DELETE     /api/settings/api-keys[/:id]
```

## MCP Server (Hermes/OpenCode)

- **Transport:** Streamable HTTP at `/mcp`, stateless mode (no session persistence — each request self-contained, fits Workers).
- **Auth:** `Authorization: Bearer lxk_...` — same validation as REST.
- **Pagination:** all `list_*`/`search_*` tools accept `limit` (default 50) + `cursor` and return `nextCursor`. Protects the agent's context window.

### Tools

| Tool | Input (key fields) | Notes |
|------|--------------------|-------|
| `create_task` | project, column, title, description?, priority?, type?, assignee?, swimlane? | |
| `list_tasks` | project, column?, swimlane?, assignee?, type?, limit?, cursor? | |
| `get_task` | taskId | |
| `update_task` | taskId, title?, description?, priority?, assignee? | |
| `move_task` | taskId, columnId, beforeTaskId?, afterTaskId? | atomic; errors: WIP_LIMIT, REQUIRED_FIELD |
| `delete_task` | taskId | |
| `get_wiki_page` | project, pageSlug | |
| `create_wiki_page` | project, title, content, parentSlug? | |
| `update_wiki_page` | project, pageSlug, title?, content? | |
| `list_wiki_pages` | project, limit?, cursor? | |
| `search_wiki` | project, query, limit? | FTS5-backed |
| `link_github_issue` | taskId, repo | creates GitHub issue from task; ALREADY_LINKED guard |
| `unlink_github_issue` | taskId | |
| `list_projects` | — | |
| `get_project` | slug | |
| `get_project_status` | slug | columns + task counts (board overview) |

Removed from v1: `create_label`, `list_labels` (feature cut).

## GitHub Integration

### GitHub App (pinned scope)
- **Permissions:** Issues: Read & Write; Metadata: Read. Nothing else.
- **Subscribed events:** `issues.closed`, `issues.reopened`, `issues.edited`. (`issues.opened` dropped — auto-creating Lexa tasks from GitHub issues is out of scope; `issues.labeled` dropped — no label feature.)
- Installation tokens cached ~50 min (1h TTL minus margin), never minted per call.

### Sync matrix — what syncs, which direction, who wins

| Data | Lexa → GitHub | GitHub → Lexa |
|------|:---:|:---:|
| Issue state ↔ column (via `columns.github_state`) | ✅ on task move (best-effort, non-blocking) | ✅ on webhook |
| Issue title | ❌ | ✅ on `issues.edited` (GitHub wins) |
| Issue body ↔ task description | ❌ (link only) | ❌ |
| Assignees | ❌ | ❌ |

The asymmetry is deliberate and documented: Lexa owns the board, GitHub owns the issue text. Conflict surface is minimal because only state flows both ways.

### Echo suppression & idempotency (the loop-killer)

```
Move in Lexa → syncStateFromLexa() → GitHub issue closed
                    │                         │
                    ▼                         ▼
     tasks.github_synced_state      webhook: issues.closed
         = 'closed'                          │
                                             ▼
                              payload state == synced_state?
                                    YES → skip (our echo)
                                    NO  → move task (bypass WIP/policies)
```

1. `webhook_events` dedups on `X-GitHub-Delivery` (at-least-once delivery).
2. Webhook acks 200 immediately; processing in `ctx.waitUntil` (GitHub's 10s timeout).
3. Echo suppression via `github_synced_state` comparison.
4. Webhook column lookup by `github_state` mapping — **never by name** (renaming "Done" can't break sync).
5. Webhook-driven moves bypass WIP limits and required_fields (`bypassGuards: true`) — robots ≠ humans.
6. `move()` early-returns on no-op (same column, no reposition).
7. One task ↔ one issue: `UNIQUE(github_issue_id)` + already-linked guard.
8. Failed Lexa→GitHub sync diverges by design (best-effort, no retry queue). The UI surfaces it: a linked task shows "out of sync" when `github_synced_state` ≠ its column's `github_state`. Manual re-move resyncs.

### Trust boundary (explicit decision)
Anyone with issue-triage permission on a linked repo can trigger webhook-driven board moves (close/reopen an issue → card moves, bypassing WIP and required_fields). This is intentional — GitHub is the source of truth for issue state (see sync matrix). On public repos, external contributors can affect the board; if that becomes a problem, the mitigation is restricting the App to private repos or filtering webhook senders — not more auth code.

## Frontend

### Routes (TanStack Start)
```
/                          → Dashboard (all projects)
/:slug                     → Kanban board
/:slug/tasks/:id           → Task detail (slideover)
/:slug/wiki                → Wiki index
/:slug/wiki/:pageSlug      → Wiki page
/:slug/settings            → Project settings (columns, swimlanes, GitHub link)
/settings                  → API keys
```

### Key Components
```
KanbanBoard
├── SwimlaneHeader (name, description truncated, "read more" modal, context menu)
│   ├── Context menu: Expand/Collapse, Settings (swimlane form), Rename, Add Column, Delete
│   └── Column
│       ├── ColumnHeader (name, count, WIP badge, context menu)
│       │   └── Context menu: Add task, Rename, Edit column (ColumnForm), Delete, Clear all tasks
│       ├── TaskCard (draggable)
│       ├── Column → InlineAddTask (title input, Priority/Type dropdowns, Save/Cancel)
│       │   └── Defaults: High priority, Feature type. Enter saves, Esc cancels.
│       └── KanbanSettingsModal (columns + swimlanes table, ColumnForm, SwimlaneForm)
│           ├── ColumnForm: 13-color palette, wipLimit, requiredFields, githubState
│           └── SwimlaneForm: name + description textarea
├── TaskDetail (slideover)
│   ├── TitleEditor (inline, click to edit)
│   ├── DescriptionEditor (TipTap, double-click to edit, save on blur)
│   ├── PropertyBar (Column dropdown, Priority badge, Type badge, Assignee chips)
│   └── GitHubSection (linked issue badge, sync status dot, out-of-sync warning)
└── BoardFilters (priority, type, assignee — floating filter bar)

WikiLayout
├── WikiSidebar (page tree — nested, collapsible, drag to reorder)
└── WikiPage
    ├── PageHeader (title, breadcrumb)
    ├── TipTapEditor (full rich text)
    └── PageMeta (last edited)

Dashboard (Command Center)
├── Header ("Command Center" + "New Project" button)
├── ProjectGrid → ProjectCard (health card variant)
│   ├── Health dot (green/amber/red — overall column health)
│   ├── Urgent count badge, Sync count badge
│   ├── WIP mini bar (colored segments per column)
│   ├── Stats footer (task count, column count)
│   ├── GitHub icon (if linked)
│   └── ⋯ settings button → project settings modal
├── StatsBar (4 aggregate stat cards: total tasks, active projects, WIP exceeded, out-of-sync)
└── AttentionSection (two-column grid)
    ├── Urgent tasks list (per-task rows with dot, title, project·column, task ID)
    └── Out-of-sync GitHub issues list (same layout, amber dot)
```

Removed from v1: `SubtaskList`, `CommentThread` (ghost features — no schema backing).

### Mutation responses are authoritative
SQLite is local (WAL) so reads are immediate, but the mutation response is still the single source of truth. Rule: **mutations return the updated entity and TanStack Query updates its cache from the mutation response (`setQueryData`) — no refetch on the mutation path.**

## File Structure

```
lexa/
├── app/                      # TanStack Start routes
│   ├── __root.tsx
│   ├── index.tsx             # Dashboard
│   ├── $slug/
│   │   ├── index.tsx         # Kanban
│   │   ├── wiki/index.tsx
│   │   ├── wiki/$page.tsx
│   │   └── settings.tsx
│   └── settings.tsx
│   ├── components/
│   │   ├── kanban/  (board, column, card, swimlane)
│   │   ├── wiki/    (editor, sidebar, page-tree)
│   │   ├── task/    (detail, property-bar)
│   │   └── ui/      (toast, modal-stack, menu)
│   └── lib/         (api.ts, queries.ts)
├── server/                   # Effect-TS services
│   ├── entry.ts              # Bun.serve — routes /mcp, /api/*, static, SSR
│   ├── api/                  # HttpApi app (http.ts), auth-key.ts, auth.ts, errors.ts
│   ├── services/             # task, project, wiki, column, swimlane, ...
│   ├── repos/                # task.repo.ts, project.repo.ts, ...
│   ├── db/                   # database.ts (bun:sqlite layer), migrate.ts
│   ├── mcp/                  # server.ts + tools/
│   └── github/               # GitHub App client + webhook
├── shared/                   # types + pure functions (markdown, positions, tiptap-text)
├── migrations/               # *.sql applied on boot by server/db/migrate.ts
├── scripts/                  # setup.sh (deploy), seed-dev.sql, mcp/
├── wireframes/               # src (source of truth) + dist (compiled)
└── package.json
```

Changes from v1: removed label service/repo/routes, policy.service.ts (folded into task.service.ts), subtask-list.tsx; added api-key.repo.ts, webhook-event.repo.ts; `routes/` renamed `api/` (HttpApi); runtime migrated from Cloudflare Workers/D1 to Bun + SQLite (commit 3315ca8).

## Development Phases

| Phase | Scope | Dependencies |
|-------|-------|-------------|
| **1. Foundation + spike** | SQLite schema, Effect repos/services (Project, Task), HttpApi scaffolding, **TanStack Start + Bun SSR spike** (validate SSR+SQLite in one process before building on it) | — |
| **2. Kanban CRUD** | Column/Swimlane services, task CRUD, atomic move + WIP + required_fields | Phase 1 |
| **3. Frontend Core** | Dashboard, kanban board (dnd-kit), task detail slideover | Phase 2 |
| **4. Wiki** | Wiki service/repo, TipTap editor, page tree, FTS search | Phase 1 |
| **5. MCP Server** | All tools, API-key auth, pagination | Phase 1 |
| **6. GitHub Sync** | GitHub App, webhook receiver (dedup + echo suppression), state sync | Phase 2 |
| **7. Polish** | Swimlanes UI, WIP warnings, settings pages, Cloudflare Access setup | Phases 3–4 |

Phases 1, 4, 5 can start together (Wiki and MCP depend only on the foundation).

## Decisions Log (v2 — merged)

1. **Fractional indexing via `fractional-indexing` npm package** — hand-rolled key generation was wrong (duplicate keys between dense neighbors). `UNIQUE(column_id, position)` + retry-on-conflict handles concurrent creates.
2. **Atomic move as one operation** — `{ columnId, swimlaneId, beforeTaskId, afterTaskId }` → one conditional UPDATE. WIP limit enforced inside the statement (no check-then-act race).
3. **Cloudflare Access for human auth** — zero auth code for a self-hosted 2–5 person tool (tunneled ingress). API keys (`lxk_` format) for machines only.
4. **Echo-suppressed GitHub sync** — `github_synced_state` comparison + delivery dedup + immediate ack. Column mapping via `columns.github_state`, never by name.
5. **No service-to-service cycles** — TaskService has no GitHub dependency; routes orchestrate Lexa→GitHub sync. GitHubService→TaskService (webhooks) is the only service edge.
6. **Cut: labels, subtasks, 2 of 3 column policies** — `tasks.type` covers categorization; TipTap checklists cover breakdown; `required_fields` is the only enforceable policy. Reversible: these are doc-level cuts, adding back later is a schema migration, not a redesign.
7. **@effect/platform HttpApi** — tagged errors map declaratively to HTTP statuses + OpenAPI generation.
8. **TipTap JSON content** (unchanged) — with app-maintained `content_text` plain-text projection for FTS5 search.
9. **Mutation-response cache updates** — frontend never refetches on the mutation path (mutation response is authoritative).
10. **No users table** (unchanged) — assignees are freeform strings; identity comes from Access/GitHub.
11. **Round-2 hardening** (oracle verification pass) — within-column reorders short-circuit the WIP check; deterministic key generation mandates re-read-then-regenerate retries for create AND move; neighborless moves default to append-to-end (never `generateKeyBetween(null,null)`); webhook delivery recorded only after successful processing; `task.github_repo` stored at link time; `/board` unpaginated endpoint; `required_fields` enforced on create/move/update.
12. **Design system: PHOSPHOR (approved)** — warm-phosphor CRT/HUD identity (see DESIGN_SYSTEM.md). Four-voice type: Space Grotesk (display), IBM Plex Sans (body), JetBrains Mono (IDs/code), Departure Mono (micro HUD labels). Brown-black `#0C0B09` surfaces, phosphor amber `#F0C040` accent, focus = amber glow ("CRT cursor"). Dark-first, density-first, gamification visual-only. First proposal (Geist/Linear-adjacent) rejected by user — no Vercel/Linear aesthetics.

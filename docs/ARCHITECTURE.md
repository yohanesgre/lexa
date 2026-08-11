# Lexa — Architecture

A lightweight, self-hosted project management tool. Kanban board, issue/task ticketing, nested wiki/docs, AI agent (MCP) access, and GitHub issue sync — running on a Bun standalone server with SQLite.

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
├── title, description (TipTap JSON), priority, type (option ids — field-config)
├── assignee (freeform string), archived_at (soft archive)
├── position (fractional-index key, UNIQUE per column)
└── timestamps
│
task_github_issues (junction — one task ↔ many issues, one per repo)
├── task_id, issue_id (GitHub node_id, UNIQUE per task), issue_number, repo ("owner/name")
└── synced_state (last known issue state — per-issue echo suppression)
│
task_links (subtask_of / blocked_by / related_to)
└── id, project_id, from_task_id, to_task_id, relation
│
wiki_pages (nested)
├── id, title, slug (UNIQUE per project), content (TipTap JSON)
├── content_text (plain text, backs FTS5 search)
├── parent_id (ON DELETE RESTRICT), position
└── timestamps
│
api_keys                        webhook_events
├── id, name, key_hash (SHA-256) ├── delivery_id (X-GitHub-Delivery, PK)
└── timestamps                   └── received_at (pruned >7 days at boot)
```

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

### Request pipeline

`server/entry.ts` is the Bun.serve edge: boot/migrations, the webhook branch
(HMAC before parse), `/mcp` (rate check + stream cap + handler), static/SSR,
and the `/api` **stream cap** (`readBodyWithLimit` — chunked bodies cannot
bypass `LXK_MAX_BODY_MB`; the request is reconstructed and the resolved
socket IP is stamped as `x-lexa-remote-ip`, inbound header deleted first to
prevent spoofing — socket IP is only visible at this layer).

Everything else runs as HttpApi middleware (`server/api/middleware.ts`),
applied at build time, before route matching and before body decode:

1. **Rate limit** — per-IP, `isPrivateIp`-gated `cf-connecting-ip` trust; `/api/setup` + `/api/health` ARE limited; key/token-gated Forge machine surfaces exempt (`/api/forge/daemon/*` + `/api/forge/runtimes/register` + `/api/forge/machines/heartbeat` — log streams and the 3s listener heartbeat must not 429); shares one bucket with `/mcp` (`apiRateLimiter`); limits DB-configured (settings `settings.rate_limit_max` / `settings.rate_limit_window_ms`, code defaults 6000 req / 600_000 ms as fallback — `GET`/`PUT /api/settings/rate-limit`, applied at boot and on save via `syncRateLimitFromDb`)
2. **Content-length pre-check** — declared size > `LXK_MAX_BODY_MB` → 413 fast-path (stream cap above stays authoritative)
3. **Auth** — daemon token (`x-forge-token`, constant-time) for `/api/forge/daemon/*` + `/api/forge/runtimes/register`, else Bearer key → `resolveApiKeyIdentity` on the shared connection; setup/health auth-exempt; 401/403 envelopes byte-identical to the old dispatcher
4. **`AuthIdentity` provision** — handlers read the Context tag (no per-request DB opens)
5. **Security headers** — nosniff + no-store on every `/api` response, including router 404s

## MCP Server (Hermes/OpenCode)

- **Transport:** Streamable HTTP at `/mcp`, stateless mode (no session persistence — each request self-contained).
- **Auth:** `Authorization: Bearer lxk_...` — same validation as REST.
- **Pagination:** all `list_*`/`search_*` tools accept `limit` (default 50) + `cursor` and return `nextCursor`. Protects the agent's context window.

Tools: `create_task`, `list_tasks`, `get_task`, `update_task`, `move_task`, `delete_task`, `get_wiki_page`, `create_wiki_page`, `update_wiki_page`, `list_wiki_pages`, `search_wiki`, `link_github_issue`, `unlink_github_issue`, `list_projects`, `get_project`, `get_project_status`. Full contract in MCP.md.

## GitHub Integration

### GitHub App (pinned scope)
- **Permissions:** Issues: Read & Write; Metadata: Read; **Contents: Read** (Forge repo-content context). Nothing else.
- **Subscribed events:** `issues.closed`, `issues.reopened`, `issues.edited`. (`issues.opened` dropped — auto-creating Lexa tasks from GitHub issues is out of scope; `issues.labeled` dropped — no label feature.)
- Installation tokens cached ~50 min (1h TTL minus margin), never minted per call.
- **Config model — the settings DB is the single source of truth at runtime** (`GET`/`PUT /api/settings/github`, admin-only): `settings.github_app_id` / `github_private_key` / `github_webhook_secret`. Env (`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` / `GITHUB_WEBHOOK_SECRET`) is a **first-boot bootstrap only**: `mirrorSettingsFromEnv` copies it into the DB once at boot when keys are empty (inline PEM wins over the file; the file is read at mirror time), and the runtime never reads env again. **Upgrade note:** existing env-only deployments import their env config into the DB on the first boot after this change — no manual migration. `GitHubConfigLive` serves a mutable holder — `syncGitHubConfigFromDb` (boot + on save) applies DB values live, `resetGithubCaches()` drops stale installation/token caches, and the webhook verifier reads the secret per request. Secrets are write-only over the API (booleans only); GET `source` is `"settings"` (any github_* row) or `"none"` — there is no env state.
- **Forge repo-content (best-effort):** on daemon claim, a task's linked GitHub repos (≤ 3, from `task_github_issues`) are fetched via the Contents API — default branch → recursive tree → `selectRepoFiles` (skips node_modules/dist/binaries/lockfiles; ≤ 50 files, ≤ 256 KB each, ≤ 512 KB total) → per-file base64 content. Delivered in the claim as `repoContent` (the daemon writes it into repo-content/ + MANIFEST.md; the prompt points the agent there). Every failure — unconfigured app, missing repo, network, per-file error — skips with a warn; a claim NEVER fails for missing context (`selectRepoFiles` in `server/github/repo-content.ts`, assembly in the claim handler).

### Sync matrix — what syncs, which direction, who wins

| Data | Lexa → GitHub | GitHub → Lexa |
|------|:---:|:---:|
| Issue state ↔ column (via `columns.github_state`) | ✅ on task move (best-effort, non-blocking) | ✅ on webhook |
| Issue title | ❌ | ✅ on `issues.edited` (GitHub wins) |
| Issue body ↔ task description | ❌ (link only) | ❌ |
| Assignees | ❌ | ❌ |

The asymmetry is deliberate: Lexa owns the board, GitHub owns the issue text. Conflict surface is minimal because only state flows both ways.

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
2. Webhook acks 200 immediately; processing in the background (Bun has no `waitUntil` — ack first, then fire-and-forget on a shared Effect runtime; GitHub's 10s timeout is respected by the immediate ack).
3. Echo suppression via per-link `synced_state` comparison (`task_github_issues.synced_state` — one row per linked issue).
4. Webhook column lookup by `github_state` mapping — **never by name** (renaming "Done" can't break sync).
5. Webhook-driven moves bypass WIP limits and required_fields (`bypassGuards: true`) — robots ≠ humans; archived tasks are never moved.
6. `move()` early-returns on no-op (same column, no reposition).
7. One task ↔ many issues (junction table), one per repo: duplicate repo links rejected (already-linked guard). Per-issue `UNIQUE(task_id, issue_id)`.
8. Failed Lexa→GitHub sync diverges by design (best-effort, no retry queue). The UI surfaces it: a linked task shows "out of sync" when `synced_state` ≠ its column's `github_state`. Manual re-move resyncs.

### Trust boundary
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

Key components: `KanbanBoard` (swimlanes → columns → task cards, inline add, settings modal), `TaskDetail` slideover (title/description editors, property bar, GitHub section), `WikiLayout` (nested collapsible sidebar + TipTap page), `Dashboard` (project cards with health dots, WIP bars, stats, attention sections).

### Mutation responses are authoritative
SQLite is local (WAL) so reads are immediate, but the mutation response is still the single source of truth. Rule: **mutations return the updated entity and TanStack Query updates its cache from the mutation response (`setQueryData`) — no refetch on the mutation path.**

## File Structure

```
lexa/
├── app/                      # TanStack Start routes + components
│   ├── routes/               # dashboard, kanban, wiki, task, settings
│   ├── components/           # kanban/, wiki/, task/, ui/
│   └── lib/                  # api.ts, queries.ts
├── server/                   # Effect-TS services
│   ├── entry.ts              # Bun.serve — boot, webhook, /mcp, static/SSR, /api stream cap + IP stamp
│   ├── api/                  # HttpApi app (http.ts), middleware.ts (rate/auth/headers), auth-key.ts, auth.ts, errors.ts, limits.ts
│   ├── services/             # task, project, wiki, column, swimlane, ...
│   ├── repos/                # task.repo.ts, project.repo.ts, ...
│   ├── db/                   # database.ts (bun:sqlite layer), migrate.ts
│   ├── mcp/                  # server.ts + tools/
│   └── github/               # GitHub App client + webhook
├── shared/                   # types + pure functions (markdown, positions, tiptap-text)
├── migrations/               # *.sql applied on boot by server/db/migrate.ts
├── scripts/                  # cli/ (lexa-cli incl. deploy), forge/ (Forge daemon), dev.sh, seed-dev.sql, setup-cli.ts
├── wireframes/               # git submodule → private repo yohanesgre/lexa-wireframes
└── package.json
```
`wireframes/` is a git submodule pointing at the separate PRIVATE repo `yohanesgre/lexa-wireframes` (init with `git submodule update --init wireframes`) — see AGENTS.md.

# Lexa — Architecture

A lightweight, self-hosted project management tool. Kanban board, issue/task ticketing, nested wiki/docs, and GitHub issue sync — running on a Bun standalone server with SQLite.

## Tech Stack

| Layer        | Choice                        | Rationale |
| ------------ | ----------------------------- | --------- |
| Frontend     | React + Vite + TanStack Start | SSR for initial load, SPA-like after, file-based routing |
| Backend      | Effect-TS + @effect/platform HttpApi | Typed errors, DI, declarative error→HTTP mapping, OpenAPI for free |
| Database     | SQLite via bun:sqlite (WAL)   | Local file, zero-ops, transactional batch helper for atomic mutations |
| Runtime      | Bun standalone HTTP server (Docker) | One process for SSR + REST + webhooks; simple deploys |
| Human auth   | In-process Better Auth 1.6.27 (pinned) | Email/password login + cookie sessions at `/api/auth/*`; no edge auth, no external IdP, no SMTP |
| Machine auth | API keys (`lxk_` + base62(43B)) | Hermes/CLI/webhooks: Bearer key → SHA-256 lookup |
| GitHub Sync  | GitHub App + Webhooks         | Issues r/w + Metadata read only; echo-suppressed two-way state sync |
| Styling      | Tailwind                      | Fast, tree-shaken |
| Rich Text    | TipTap (ProseMirror)          | Structured JSON, React integration |
| Drag & Drop  | @dnd-kit                      | Accessible, works with fractional-index positions |
| Ordering     | `fractional-indexing` (npm)   | `generateKeyBetween` — correct, tiny, Workers-safe |

## Data Model

See SCHEMA.md for the full SQL. Conceptual view:

```
projects
├── id, name, slug (UNIQUE), description, timestamps
├── team_id (owning team — organization id; NULL = unassigned, superadmin-only)
│
project_repos (N repos per project, each with roles)
├── id, project_id, repo ("owner/name", UNIQUE per project)
├── source_role (Forge context + project label), workspace_role (issue link/create/sync)
└── created_at — at least one role per row
│
columns (per project, ordered)
├── id, name, position, color, wip_limit
├── required_fields (JSON array — the only column policy)
└── github_state ('open'|'closed'|NULL — explicit sync mapping)
│
swimlanes (per project, ordered — sprint lanes + one permanent Backlog)
├── id, name, position, kind ('backlog'|'sprint'), milestone_id (nullable)
├── start_at / due_at (sprint dates), archived_at (soft archive)
│
milestones (goal wrapper above sprints)
├── id, name, description, position, due_at, archived_at
└── ON DELETE SET NULL on swimlanes.milestone_id — deleting loosens sprints
│
tasks
├── id, column_id, swimlane_id (NOT NULL — every task belongs to a lane), project_id
├── title, description (TipTap JSON), priority, type (option ids — field-config)
├── key (ticket key "PREFIX-n", immutable), number (per-project, never reused)
├── assignee (freeform string), archived_at (soft archive)
├── position (fractional-index key, UNIQUE per column)
└── timestamps
│
task_github_issues (junction — one task ↔ many issues, one per repo)
├── task_id, issue_id (GitHub node_id, UNIQUE per task), issue_number, repo ("owner/name")
├── synced_state (last known issue state — per-issue echo suppression)
└── pushed_title / pushed_body / push_failed (content-sync echo + divergence)
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

### Humans → in-app sessions (Better Auth)
Better Auth 1.6.27 (pinned, MIT) runs **in-process** on the Bun server
(`server/auth.ts` — credentials + organization plugins,
`tanstackStartCookies` LAST, `baseURL` = `LXK_PUBLIC_URL`, secure cookies,
trusted origins). Mounted at `/api/auth/*` **before** the API-key
middleware. Email/password only — no social providers, no Google OAuth
clients, no callback URIs, no SMTP anywhere.

- **Login/logout/set-password** — `/login`, `/set-password` pages; sessions
  are cookie-based, **7d sliding** (Better Auth defaults `expiresIn` 7d /
  `updateAge` 24h); logout, deactivate, and password change revoke sessions.
- **Provisioning** — the `/setup` wizard creates the first superadmin
  (email + password, no email needed); superadmin-issued **workspace invite
  links** and **set-password links** onboard members (link-based, 7d expiry,
  shared out-of-band — no email transport). **No public signup** — signup is
  disabled (`disableSignUp`); provisioning is admin-curated (allow-list
  bootstrap + workspace invites). Teams are **intra-server workspaces, not
  multi-tenancy** — one server, one DB, one superadmin. Email addresses are
  immutable (no verification without SMTP) — changing one means delete +
  re-invite.
- **Roles** — `users.role` ∈ {superadmin, member}; superadmin is **env-only**
  (`LXK_ADMIN_EMAILS`, applied at provisioning), never edited at runtime.
  Team-admin authority comes from the org `member.role` (owner/admin) on the
  team. Teams = Better Auth organizations; projects carry `team_id`;
  runtimes are team-scoped (`team_id` NULL = superadmin-owned global).
- **Authorization order (project access):** superadmin > explicit
  `user_project_roles` grant > team membership > deny (see LAYERS.md →
  AuthorizationService).

### Machines → API keys
`Authorization: Bearer lxk_<base62(43 random bytes)>`. Server: `SHA-256(raw)` → `api_keys.key_hash` lookup. Keys are full read/write — **no scopes** (single-agent trust model, explicit). `last_used_at` updated only when NULL or stale >1h. CLI/webhooks unchanged.

The webhook route is exempt from API-key middleware — it authenticates via `X-Hub-Signature-256` (HMAC-SHA-256 over the raw body, constant-time compare, verified before parsing).

### Dual channel + attribution
`/api/*` accepts a session cookie OR a Bearer key (session first, key
fallback). The `x-lxk-user` header is removed. The `<meta name="lxk-api-key">`
injection / `VITE_LXK_API_KEY` remain — the server injects its current
`LXK_API_KEY` into the served HTML and the client prefers it over the
build-time baked key; browsers otherwise authenticate via the cookie.
Attribution: browser actor = session user; machine actor = key name.

## API Routes (REST)

All list endpoints paginate: `?limit` (default 50, max 200) + opaque cursor — **except `/board`**, which returns the complete board snapshot. Auth: session cookie (humans) or Bearer key (machines), implemented as HttpApi middleware; `/api/auth/*` is mounted before it. See API.md for the full contract.

```
Auth              GET/POST            /api/auth/*        (Better Auth handler — pre-middleware)

Projects          GET/POST            /api/projects
                  GET/PATCH/DELETE    /api/projects/:slug
                  PATCH               /api/projects/:projectId/team   { teamId: string | null }

Teams             GET/POST            /api/teams
                  DELETE              /api/teams/:teamId
                  GET/POST            /api/teams/:teamId/members
                  PATCH/DELETE        /api/teams/:teamId/members/:userId

Workspace         GET/PATCH/DELETE    /api/workspace/members[/:userId]
                  POST/DELETE         /api/workspace/invites[/:inviteId]
                  POST                /api/workspace/members/:userId/set-password-link

Sessions          GET                 /api/sessions
                  POST                /api/sessions/:sessionId/revoke

Columns           GET/POST            /api/projects/:slug/columns
                  PATCH/DELETE        /api/projects/:slug/columns/:id
                                      (DELETE non-empty → 409 ColumnNotEmpty)

Swimlanes         GET/POST            /api/projects/:slug/swimlanes
                  PATCH/DELETE        /api/projects/:slug/swimlanes/:id

Milestones        GET/POST            /api/projects/:slug/milestones
                  GET/PATCH/DELETE    /api/projects/:slug/milestones/:id
                  POST                /api/projects/:slug/milestones/:id/archive
                  POST                /api/projects/:slug/milestones/:id/restore

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
(HMAC before parse), static/SSR,
and the `/api` **stream cap** (`readBodyWithLimit` — chunked bodies cannot
bypass `LXK_MAX_BODY_MB`; the request is reconstructed and the resolved
socket IP is stamped as `x-lexa-remote-ip`, inbound header deleted first to
prevent spoofing — socket IP is only visible at this layer).

Everything else runs as HttpApi middleware (`server/api/middleware.ts`),
applied at build time, before route matching and before body decode:

1. **Rate limit** — per-IP, `isPrivateIp`-gated `cf-connecting-ip` trust; `/api/setup` + `/api/health` ARE limited; key/token-gated Forge machine surfaces exempt (`/api/forge/daemon/*` + `/api/forge/runtimes/register` + `/api/forge/machines/heartbeat` — log streams and the 3s listener heartbeat must not 429); shares one bucket (`apiRateLimiter`); limits DB-configured (settings `settings.rate_limit_max` / `settings.rate_limit_window_ms`, code defaults 6000 req / 600_000 ms as fallback — `GET`/`PUT /api/settings/rate-limit`, applied at boot and on save via `syncRateLimitFromDb`). Failed logins on `/api/auth/*` are separately throttled by a small in-process memory limiter around `POST /api/auth/sign-in/email` (~5 attempts/60s per email, 15 min lockout, success resets) — Better Auth 1.6.27 has no bundled rate-limit plugin (declared deviation, `server/auth.ts`); the per-IP limiter above is untouched.
2. **Content-length pre-check** — declared size > `LXK_MAX_BODY_MB` → 413 fast-path (stream cap above stays authoritative)
3. **Auth** — dual-channel: session cookie first (`SessionService.userFrom`, try/catch), then daemon token (`x-forge-token`, constant-time) for `/api/forge/daemon/*` + `/api/forge/runtimes/register`, else Bearer key → `resolveApiKeyIdentity` on the shared connection; `/api/auth/*` bypasses this middleware entirely; setup/health auth-exempt; 401/403 envelopes byte-identical to the old dispatcher
4. **`AuthIdentity` provision** — handlers read the Context tag (no per-request DB opens)
5. **Security headers** — nosniff + no-store on every `/api` response, including router 404s

## GitHub Integration

### GitHub App (pinned scope)
- **Permissions:** Issues: Read & Write; Metadata: Read; **Contents: Read** (Forge repo-content context). Nothing else.
- **Subscribed events:** `issues.closed`, `issues.reopened`, `issues.edited`. (`issues.opened` dropped — auto-creating Lexa tasks from GitHub issues is out of scope; `issues.labeled` dropped — no label feature.)
- Installation tokens cached ~50 min (1h TTL minus margin), never minted per call.
- **Config model — the settings DB is the single source of truth at runtime** (`GET`/`PUT /api/settings/github`, admin-only): `settings.github_app_id` / `github_private_key` / `github_webhook_secret`. Env (`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` / `GITHUB_WEBHOOK_SECRET`) is a **first-boot bootstrap only**: `mirrorSettingsFromEnv` copies it into the DB once at boot when keys are empty (inline PEM wins over the file; the file is read at mirror time), and the runtime never reads env again. **Upgrade note:** existing env-only deployments import their env config into the DB on the first boot after this change — no manual migration. `GitHubConfigLive` serves a mutable holder — `syncGitHubConfigFromDb` (boot + on save) applies DB values live, `resetGithubCaches()` drops stale installation/token caches, and the webhook verifier reads the secret per request. Secrets are write-only over the API (booleans only); GET `source` is `"settings"` (any github_* row) or `"none"` — there is no env state.
- **Forge repo-content (best-effort):** on daemon claim, the project's **source-role repos** (≤ `settings.forge_repo_cap`, default 3, env bootstrap `LXK_FORGE_REPO_CAP` — same pattern as rate limits) are fetched via the Contents API — default branch → recursive tree → `selectRepoFiles` (skips node_modules/dist/binaries/lockfiles; ≤ 50 files, ≤ 256 KB each, ≤ 512 KB total) → per-file base64 content. Delivered in the claim as `repoContent` (the daemon writes it into repo-content/ + MANIFEST.md; the prompt points the agent there). Every failure — unconfigured app, missing repo, network, per-file error — skips with a warn; a claim NEVER fails for missing context (`selectRepoFiles` in `server/github/repo-content.ts`, assembly in the claim handler).

### Sync matrix — what syncs, which direction, who wins

| Data | Lexa → GitHub | GitHub → Lexa |
|------|:---:|:---:|
| Issue state ↔ column (via `columns.github_state`) | ✅ on task move (best-effort, non-blocking) | ✅ on webhook |
| Issue title + body (content, asymmetric) | ✅ on task save when title/description changed (best-effort, after commit; echo columns `pushed_title`/`pushed_body`; failure → `push_failed`) | ✅ on `issues.edited` via API fetch (echo-checked, GitHub wins) |
| Issue body ↔ task description | (same row above — content sync) | (same row above — content sync) |
| Assignees | ❌ | ❌ |

The asymmetry is deliberate: Lexa owns the board, GitHub owns the issue text. State flows both ways (echo-suppressed); content flows both ways but **asymmetrically** — Lexa pushes on save (TipTap → Markdown), GitHub edits pull back via `edited` (Markdown → TipTap), and the webhook skips our own pushes by comparing fetched title **and** body against `pushed_*` after trim + CRLF→LF normalization.

**Repo roles:** a project links N repos via `project_repos`, each with independent `source_role` (Forge context + project label) and `workspace_role` (issue link/create/sync) booleans — at least one per row. Workspace-role repos gate NEW issue links; removing a role never freezes existing links. Forge context sources from the project's source-role repos (cap `settings.forge_repo_cap`, default 3).

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
9. **Content sync is asymmetric + echo-safe.** Lexa pushes title+body on task save (only when changed, after the mutation commits; diffed against `pushed_title`/`pushed_body`; the push itself emits no activity). The webhook `edited` handler GETs the issue, skips when fetched title+body both match `pushed_*` (trim + CRLF→LF via `normalizeMarkdownForEcho`; GET failure → title-only compare fallback), else applies title + description (Markdown → TipTap) emitting `field_changed` (actor system/'github') in the same transaction. `push_failed` drives the "edit not pushed" divergence reason.
10. **Repo roles gate new links only.** `source_role` (Forge context + label) and `workspace_role` (issue link/create/sync) are independent; removing a role never freezes existing task↔issue links — they keep syncing.

### Trust boundary
Anyone with issue-triage permission on a linked repo can trigger webhook-driven board moves (close/reopen an issue → card moves, bypassing WIP and required_fields). This is intentional — GitHub is the source of truth for issue state (see sync matrix). On public repos, external contributors can affect the board; if that becomes a problem, the mitigation is restricting the App to private repos or filtering webhook senders — not more auth code.

## Forge — two active AI tiers

Forge is the umbrella for both AI execution tiers. Both are ACTIVE and
co-exist; the run popover picks per-run. Design rationale: `docs/ADR-0001-two-tier-ai-architecture.md`; implementation plan + decisions log:
`docs/HERALD_PLAN.md`.

| | Herald | Blacksmith |
|---|---|---|
| Role | Writing + PM assistant | Coding agent |
| Engine | Server-side TanStack AI `chat()` (`server/herald/provider.ts`) | listener/daemon/warm `opencode serve` |
| Queue consumer | HTTP stream handler, in-process | daemons via `claimNextTask` |
| Thread state | `herald_threads` (ModelMessage[] JSON, rolling summary) | `forge_sessions` |
| Agents/skills render | prompt injection via systemPrompts | `.agents/` file writes |

- **Shared queue with a discriminator:** both tiers ride `forge_tasks`;
  `kind` ∈ `'herald' | 'blacksmith'`. `claimNextTask` carries
  `AND kind='blacksmith'` — daemons can never claim Herald tasks; Herald
  streams claim via a kind-scoped conditional UPDATE.
- **Catalog renamed Lexa Agents/Skills** (`lexa_agents` / `lexa_skills` /
  `lexa_agent_skills`, migration 0010): it is the behavioral spec for BOTH
  renderers — prompt injection renders it for Herald, `.agents/` file writing
  renders it for Blacksmith. Routes `/api/agents` + `/api/skills` (hard
  cutover from the forge-prefixed paths); claim-payload field names
  (`agentMarkdown`/`skillMarkdown`) frozen for daemon wire compatibility.
- **Herald** runs per-project provider settings (`herald_settings`, custom
  OpenAI-/Anthropic-compatible endpoints), server-side tools v1 (Exa web
  search, SSRF-guarded `fetch_url`, `read_s3_file`, PM reads), curated
  `project_memory` FTS5 facts, and a freeform chat surface on the same engine.
- **Blacksmith** is unchanged: machine/listener/daemon infrastructure remains
  deliberately for coding work (shell, file edits, sandboxes).

## Frontend

### Routes (TanStack Start)
```
/                          → Homepage (all projects, team-scoped)
/login                     → login (email + password)
/set-password              → set/forgot password (admin-issued link token)
/:slug                     → Project dashboard (health, WIP status, attention)
/:slug/board               → Kanban board (swimlanes → columns → task cards)
/:slug/tasks               → Task list (flat, filterable, key-first rows)
/:slug/milestones          → Milestones (list + timeline/gantt)
/:slug/swimlanes           → Swimlanes (sprints grouped by milestone)
/:slug/wiki                → Wiki index
/:slug/wiki/:pageSlug      → Wiki page
/:slug/settings            → Project settings (columns, swimlanes, GitHub link, team assignment)
/settings                  → role-redirect landing
/settings/me               → profile, password change, sessions
/settings/team             → team profile, members, projects, runtimes (team admin)
/settings/project/:projectId → project settings hub (admin)
/settings/workspace        → members, invites, teams, API keys, machines, rate limits, GitHub, Forge (superadmin)
/forge                     → Forge run history (all projects)
```

Key components: `KanbanBoard` (swimlanes → columns → task cards, inline add, settings modal), `TaskDetail` slideover (title/description editors, property bar, GitHub section), `WikiLayout` (nested collapsible sidebar + TipTap page), `Dashboard` (project cards with health dots, WIP bars, stats, attention sections).

### Mutation responses are authoritative
SQLite is local (WAL) so reads are immediate, but the mutation response is still the single source of truth. Rule: **mutations return the updated entity and TanStack Query updates its cache from the mutation response (`setQueryData`) — no refetch on the mutation path.**

## File Structure

```
lexa/
├── app/                      # TanStack Start routes + components
│   ├── routes/               # dashboard, kanban, tasks, milestones, swimlanes, wiki, settings, forge
│   ├── components/           # activity/, auth/, forge/, kanban/, layout/, milestones/, settings/, swimlanes/, ui/, wiki/ + flat task components (TaskDetail.tsx, TaskPropertyBar.tsx, TaskTitleInput.tsx)
│   └── lib/                  # api.ts, queries.ts
├── server/                   # Effect-TS services
│   ├── entry.ts              # Bun.serve — boot, webhook, static/SSR, /api stream cap + IP stamp
│   ├── auth.ts               # Better Auth instance (credentials + organization + tanstackStartCookies)
│   ├── api/                  # HttpApi app (http.ts), middleware.ts (rate/auth/headers), auth-key.ts, auth.ts, errors.ts, limits.ts
│   ├── services/             # task, project, wiki, column, swimlane, session, authorization, workspace-invites, password-links, ...
│   ├── repos/                # task.repo.ts, project.repo.ts, ...
│   ├── db/                   # database.ts (bun:sqlite layer), migrate.ts
│   └── github/               # GitHub App client + webhook
├── shared/                   # types + pure functions (markdown, positions, tiptap-text)
├── migrations/               # *.sql applied on boot by server/db/migrate.ts
├── cli/                      # lexa-cli (operator CLI incl. deploy)
├── forge/                    # Forge daemon
├── scripts/                  # compile-cli.ts, dev.sh, install-cli-dev.sh, install-cli.sh, prepare-effect.sh, seed-dev.sql, setup-cli.ts
├── wireframes/               # git submodule → private repo yohanesgre/lexa-wireframes
└── package.json
```
`wireframes/` is a git submodule pointing at the separate PRIVATE repo `yohanesgre/lexa-wireframes` (init with `git submodule update --init wireframes`) — see AGENTS.md.

# Lexa — Architecture

A lightweight, self-hosted project management tool. Kanban board, issue/task ticketing, nested wiki/docs, and GitHub issue sync — running on Cloudflare Workers or a Bun standalone server with SQLite.

## Tech Stack

| Layer        | Choice                        | Rationale |
| ------------ | ----------------------------- | --------- |
| Frontend     | React + Vite + TanStack Start | Root route `ssr: true`; every authed/app route declares `ssr: false` and stays client-only (build-time root shell served for them). Public `/share/$token` has no `ssr: false`, so its loader + `head` server-render on both flavors (real title/OG for link unfurlers, rendered content for no-JS). TanStack Router + Query, file-based routing; `server/entry.ts` serves the shell + SPA fallback and routes only `/share/*` through the Start SSR handler; Workers: same model |
| Backend      | Effect-TS + @effect/platform HttpApi | Typed errors, DI, declarative error→HTTP mapping, OpenAPI for free |
| Database     | SQLite via bun:sqlite (WAL)   | Local file, zero-ops, transactional batch helper for atomic mutations |
| Runtime      | Cloudflare Workers + D1 + R2 — the only actively developed deploy target (Workers Paid, $5/mo — see `docs/CLOUDFLARE_WORKERS.md`); Bun standalone HTTP server kept as a frozen flavor | Edge isolates host SSR + REST + webhooks and are the only target receiving new features. The Bun flavor keeps running at current features — existing installs keep working, no new work lands there (see ADR-0003) |
| Human auth   | In-process Better Auth 1.6.27 (pinned) | Email/password login + cookie sessions at `/api/auth/*`; no edge auth, no external IdP; Workers transactional mail only via the Cloudflare `send_email` binding (no SMTP) |
| Machine auth | API keys (`lxk_` + base62(43B)) | CLI/webhooks/scripts: Bearer key → SHA-256 lookup |
| GitHub Sync  | GitHub App + Webhooks         | Issues r/w + Metadata read only; echo-suppressed two-way state sync |
| Styling      | Tailwind                      | Fast, tree-shaken |
| Documents    | Markdown strings            | Source is stored verbatim; parsed only for display, search, and semantic validation |
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
├── source_role (assistant grounding + project label), workspace_role (issue link/create/sync)
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
├── title, description (Markdown string), priority, type (option ids — field-config)
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
├── id, title, slug (UNIQUE per project), content (Markdown string)
├── content_text (plain-text projection, backs FTS5 search)
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
clients, no callback URIs, no SMTP transport. On Workers, transactional mail
uses the native `send_email` binding only (`EMAIL` + `LXK_EMAIL_FROM`);
Cloudflare Email Sending is Beta.

- **Login/logout/set-password** — `/login`, `/set-password` pages; sessions
  are cookie-based, **7d sliding** (Better Auth defaults `expiresIn` 7d /
  `updateAge` 24h); logout, deactivate, and password change revoke sessions.
- **Self-service recovery** — when `GET /api/capabilities` reports
  `passwordRecovery: true`, the login page offers a request form;
  `POST /api/auth/request-password-reset` is wrapped above the native Better
  Auth handler so strict rolling address/IP admission runs in D1 before the
  uniform acknowledgement, and the eligibility → native **30-minute** token →
  fixed email job rides `ctx.waitUntil`. Unknown/banned/pending-invite
  addresses get the same response and receive nothing.
- **Provisioning** — the `/setup` wizard creates the first superadmin
  (email + password, no email needed); superadmin-issued **workspace invite
  links** and **set-password links** onboard members (7d expiry, single use).
  When email is configured, creation also attempts one delivery; the link and
  row remain the authoritative result even when submission fails, so the
  admin can always hand it over out-of-band. **No public signup** — signup is
  disabled (`disableSignUp`); provisioning is admin-curated (allow-list
  bootstrap + workspace invites). Teams are **intra-server workspaces, not
  multi-tenancy** — one server, one DB, one superadmin. Email addresses are
  immutable — changing one means delete + re-invite.
- **Roles** — `users.role` ∈ {superadmin, member}; superadmin is **env-only**
  (`LXK_ADMIN_EMAILS`, applied at provisioning), never edited at runtime.
  Team-admin authority comes from the org `member.role` (owner/admin) on the
  team. Teams = Better Auth organizations; projects carry `team_id`. A
  team-scoped project is never silently re-teamed: moving a project into or
  out of a team is always an explicit superadmin reassign/detach via
  `PATCH /api/projects/:slug/team { teamId }`.
- **Authorization order (project access):** superadmin > explicit
  `user_project_roles` grant > team membership > deny (see LAYERS.md →
  AuthorizationService).
- **Project-scoped admin roles do not exist.** Column/Swimlane/Milestone
  bare-id routes assume a global admin; if such roles ever land, add
  ownership checks there first.

### Machines → API keys
`Authorization: Bearer lxk_<base62(43 random bytes)>`. Server: `SHA-256(raw)` → `api_keys.key_hash` lookup. Keys are **user-bound**: a key acts as its owner (same project access and admin gates as the user's session; member keys pass per-project authorization via `AuthorizationService` and are 403'd on admin gates). API keys are full read/write **within the owner's authority** — a member key is never more powerful than the member. `user_id` NULL = **server key** (legacy/dev rows only, role admin). `last_used_at` updated only when NULL or stale >1h. CLI login uses the device pairing flow (`/api/device-login/*`, see API.md) — no manual key copy; `--url/--key` remain for scripts.

The webhook route is exempt from API-key middleware — it authenticates via `X-Hub-Signature-256` (HMAC-SHA-256 over the raw body, constant-time compare, verified before parsing).

### Dual channel + attribution
`/api/*` accepts a session cookie OR a Bearer key (session first, key
fallback). The `x-lxk-user` header is removed. The `<meta name="lxk-api-key">`
injection is removed — browsers authenticate via the session cookie.
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
Me                GET/POST/DELETE     /api/me/api-keys[/:id]          (own keys, any user)
Device login      POST                /api/device-login/requests       (key-exempt, rate-limited)
                  GET                 /api/device-login/requests/:id   (key-exempt; x-device-token)
                  POST                /api/device-login/requests/:id/{approve,deny}   (session)
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

1. **Rate limit** — per-IP; `cf-connecting-ip` is trusted only from a loopback peer or one matching `LXK_TRUSTED_PROXY_CIDRS` (`resolveClientIp`, `server/api/rate-limit.ts`); `/api/setup` + `/api/health` ARE limited; no machine/daemon surfaces are exempt (the agent-runtime tier is removed); shares one bucket (`apiRateLimiter`); limits DB-configured (settings `settings.rate_limit_max` / `settings.rate_limit_window_ms`, code defaults 6000 req / 600_000 ms as fallback — `GET`/`PUT /api/settings/rate-limit`, applied at boot and on save via `syncRateLimitFromDb`). Failed logins on `/api/auth/*` are separately throttled by a small in-process memory limiter around `POST /api/auth/sign-in/email` (~5 attempts/60s per email, 15 min lockout, success resets) — Better Auth 1.6.27 has no bundled rate-limit plugin (declared deviation, `server/auth.ts`); the per-IP limiter above is untouched.
2. **Content-length pre-check** — declared size > `LXK_MAX_BODY_MB` → 413 fast-path (stream cap above stays authoritative)
3. **Auth** — dual-channel: session cookie first (`SessionService.userFrom`, try/catch), else Bearer key → `resolveApiKeyIdentity` on the shared connection; `/api/auth/*` bypasses this middleware entirely; setup/health auth-exempt; 401/403 envelopes byte-identical to the old dispatcher
4. **`AuthIdentity` provision** — handlers read the Context tag (no per-request DB opens)
5. **Security headers** — nosniff + no-store on every `/api` response, including router 404s

### Inbound MCP server (`/mcp`)

`/mcp` is the inbound counterpart to the Assistant's outbound MCP bridge
(below), not part of the Assistant. It lets an external MCP client act as a
specific Lexa user over Streamable HTTP, served by both hosts
(`server/entry.ts`, `server/workers-entry.ts`) at the canonical origin from
`resolvePublicUrl` (`LXK_PUBLIC_URL`).

- **Stateless.** Every accepted `POST` builds one `McpServer` plus
  `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/sdk`
  1.30.1) and closes both after the response: no session id, no server-held
  identity, no Durable Object, no registration. `GET`/`DELETE` answer 405
  because no server-initiated stream or session exists.
- **Personal bearer only.** Auth runs per request, before any protocol work:
  `resolveApiKeyIdentity` (Bun) or `resolveApiKeyIdentityAsync` (Workers)
  against a user-bound `lxk_` key. A key row with `user_id NULL` resolves to a
  server-owned admin on REST but is refused here, and the session cookie is
  never read. Nothing is cached, so revocation and removed project access take
  effect on the next request.
- **Rate, body, Origin.** One charge on the shared per-IP `apiRateLimiter`
  precedes auth, exactly like `/api`. The transport enforces the shared
  `LXK_MAX_BODY_MB` cap (`resolveMaxApiBody`) and the Origin allow-list from
  `resolveTrustedOrigins`; an absent Origin is accepted for non-browser
  clients.
- **In-process REST reuse.** A tool call is an adapter over one approved REST
  operation. `createRestDispatch` (`server/mcp/rest.ts`) synthesizes a `Request`
  carrying only the caller's bearer, the JSON content type, and an internal
  per-process nonce (generated lazily on first use inside a request, because
  production workerd rejects module-scope randomness), then calls the same
  authenticated handler `/api` uses. So authorization, WIP/required-field/
  deadline guards, activity transactions, Markdown validation, wiki revisions,
  and route-owned GitHub state sync on task update/move all run unchanged.
  There is no self-fetch, no direct SQL, and no new service edge (invariant #1
  holds without a new rule). The route middleware re-authenticates the bearer
  and skips only its limiter for the matching nonce, so the outer `/mcp`
  charge is the only one.
- **Bounded tool surface.** The catalog is fixed at 22 `lexa_*` tools; unknown
  tools and schema-invalid arguments are rejected by the SDK. Caller-controlled
  path segments (project slug, task id, page slug) are percent-decoded and
  checked before the `Request` is built, so a dot segment cannot retarget a tool
  at a sibling route.
- **Advertised URL.** `GET /api/capabilities` returns `mcpUrl`
  (`resolvePublicUrl(RuntimeEnv) + "/mcp"`), which the Settings → Me → API Keys
  guide copies. The value is configuration, never the request Host or
  `window.location`.

The 22-tool catalog and its REST mapping are canonical in
[`docs/API.md`](API.md#inbound-mcp-server-mcp); the per-layer call graph and the
internal-nonce trust rule are canonical in
[`docs/LAYERS.md`](LAYERS.md#inbound-mcp-server-mcp--per-request-server-over-authenticated-routes).

## GitHub Integration

### GitHub App (pinned scope)
- **Permissions:** Issues: Read & Write; Metadata: Read; **Contents: Read** (Assistant repo-content grounding). Nothing else.
- **Subscribed events:** `issues.closed`, `issues.reopened`, `issues.edited`. (`issues.opened` dropped — auto-creating Lexa tasks from GitHub issues is out of scope; `issues.labeled` dropped — no label feature.)
- Installation tokens cached ~50 min (1h TTL minus margin), never minted per call.
- **Config model — the settings DB is the single source of truth at runtime** (`GET`/`PUT`/`POST /api/settings/github*`, admin-only). Identifiers are plaintext rows: `settings.github_app_id` / `settings.github_app_slug`. The PEM and webhook secret live **encrypted** in `github_app_secrets` (scope `"github"`, AAD-bound to the row name) when written by the in-app **manifest connect flow** (`POST /api/settings/github/manifest` → GitHub App creation → `POST /api/settings/github/setup`); a manual PUT writes plaintext legacy `settings.github_private_key` / `settings.github_webhook_secret` rows instead and deletes the encrypted one (last explicit write wins). Legacy plaintext rows stay readable as a fallback — encrypted-first resolution, and a present-but-unopenable encrypted row reads as unset, never as a plaintext fallback. The DB is the only config surface: the runtime never reads GitHub config from env. `GitHubConfigLive` serves a mutable holder — `syncGitHubConfigFromDbAsync` applies DB values live at Bun boot (`runGithubConfigBoot`), at Workers boot, and on every save (async because decrypting suspends), `resetGithubCaches()` drops stale installation/token caches, and the webhook verifier reads the secret per request. Secrets are write-only over the API (booleans only); GET `source` is `"settings"` (app id or either credential set — a slug alone is not enough) or `"none"` — there is no env state. The manifest-connect state (`settings.github_manifest_state`) is single-use and expires after 10 minutes. An admin-gated live install probe (`GET /api/settings/github/installations`) and a per-installation repo listing (`GET /api/settings/github/search-repos`) back the Settings surfaces — no global GitHub search. The installations probe is 60s-cached and degrades to `unknown` when GitHub is unreachable; the repo listing is not cached and returns 502 on total failure.
- **Assistant repo-content (best-effort):** when an assistant run is enqueued, the project's **source-role repos** (≤ `settings.assistant_repo_cap`, default 3, env bootstrap `LXK_ASSISTANT_REPO_CAP` — same pattern as rate limits) are fetched via the Contents API — default branch → recursive tree → `selectRepoFiles` (skips node_modules/dist/binaries/lockfiles; ≤ 50 files, ≤ 256 KB each, ≤ 512 KB total) → per-file base64 content, passed to the prompt as grounding context. Every failure — unconfigured app, missing repo, network, per-file error — skips with a warn; a run NEVER fails for missing context (`selectRepoFiles` in `server/github/assistant-repo-content.ts`, assembly in the assistant task service).

### Sync matrix — what syncs, which direction, who wins

| Data | Lexa → GitHub | GitHub → Lexa |
|------|:---:|:---:|
| Issue state ↔ column (via `columns.github_state`) | ✅ on task move (best-effort, non-blocking) | ✅ on webhook |
| Issue title + body (content, asymmetric) | ✅ on task save when title/description changed (best-effort, after commit; echo columns `pushed_title`/`pushed_body`; failure → `push_failed`) | ✅ on `issues.edited` via API fetch (echo-checked, GitHub wins) |
| Issue body ↔ task description | (same row above — content sync) | (same row above — content sync) |
| Assignees | ❌ | ❌ |

The asymmetry is deliberate: Lexa owns the board, GitHub owns the issue text. State flows both ways (echo-suppressed); content flows both ways but asymmetrically. Both sides exchange Markdown strings directly. The webhook skips our own pushes by comparing fetched title **and** body against `pushed_*` after trim + CRLF→LF normalization; `normalizeMarkdownForEcho` remains a boundary-only comparison helper.

**Repo roles:** a project links N repos via `project_repos`, each with independent `source_role` (Assistant grounding + project label) and `workspace_role` (issue link/create/sync) booleans — at least one per row. Workspace-role repos gate NEW issue links; removing a role never freezes existing links. Assistant grounding sources from the project's source-role repos (cap `settings.assistant_repo_cap`, default 3).

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
9. **Content sync is asymmetric + echo-safe.** Lexa pushes title+body on task save (only when changed, after the mutation commits; diffed against `pushed_title`/`pushed_body`; the push itself emits no activity). The webhook `edited` handler GETs the issue, skips when fetched title+body both match `pushed_*` (`normalizeMarkdownForEcho`; GET failure → title-only compare fallback), else applies title + Markdown description and emits `field_changed` (actor system/'github') in the same transaction. `push_failed` drives the "edit not pushed" divergence reason.
10. **Repo roles gate new links only.** `source_role` (Assistant grounding + label) and `workspace_role` (issue link/create/sync) are independent; removing a role never freezes existing task↔issue links — they keep syncing.

### Trust boundary
Anyone with issue-triage permission on a linked repo can trigger webhook-driven board moves (close/reopen an issue → card moves, bypassing WIP and required_fields). This is intentional — GitHub is the source of truth for issue state (see sync matrix). On public repos, external contributors can affect the board; if that becomes a problem, the mitigation is restricting the App to private repos or filtering webhook senders — not more auth code.

## Assistant — one AI execution tier (the agent-runtime tier is removed)

> **ADR-0005 (accepted 2026-10-10; W6 removal landed) supersedes ADR-0003 for
> the assistant executor.** Chat and document runs run **in-process** on
> TanStack AI over SSE on **both flavors** (D7): no `AIChatAgent`, no
> WebSocket executor, no DO-owned canonical transcript store, no
> `/api/internal/assistant/*` HMAC routes, no D1 mirror/migrate-on-read, no
> facet delegation, and no assistant schedule executor. D1
> `assistant_threads` remains the canonical transcript store. W6 removed the
> old executor modules; ADR-0006 later added the separate opt-in supervisor.
> The historical paragraphs below describe the retired executor.

> **ADR-0006 (accepted 2026-10-12) adds an opt-in Workers-only chat supervisor,
> not a new executor.** TanStack AI remains the in-process engine and
> `assistant_threads` remains the canonical transcript store. `@cloudflare/ai-chat`
> and the `agents` SDK are excluded. The `CHAT_DO` binding plus
> `LXK_CHAT_SUPERVISOR=1` enables supervision; otherwise chat remains on the
> default request-bound SSE path. The supervisor coordinates a single active
> chat turn across isolates and lets an authorized owner replay only that same
> active turn. A different turn while one is active receives 409; messages are
> not queued and frames are not fanned out to multiple clients. The replay
> buffer is volatile: eviction/unavailability can end replay, while the
> canonical transcript remains in `assistant_threads`; continuation across
> eviction or redeploy is not guaranteed. Bun remains on the default
> request-bound path. No live-verification claim is made here.

Lexa has exactly **one** AI execution tier: the **Assistant**. In the tier
described below it runs in the server process — server-side TanStack AI `chat()`
(`server/assistant/provider.ts`), per-project provider settings
(`assistant_settings`, custom OpenAI-/Anthropic-compatible endpoints),
server-side tools v1 (Exa web search, SSRF-guarded `fetch_url`, `read_s3_file`,
PM reads), curated `project_memory` FTS5 facts, repo-content grounding from
source-role repos, and a freeform chat surface on the same engine. Document
generation uses `assistant_tasks` (`queued → running → completed|failed|cancelled`);
thread state lives in canonical `assistant_threads` (ModelMessage[] JSON, rolling
summary). Both flavors expose the assistant over SSE. The optional Workers
supervisor coordinates chat only; it is not an executor, queue, schedule runner,
or external worker.

**Attachment trust boundaries (owner decision):** chat uploads are
private to their authenticated user and conversation thread. Administrative rank,
including superadmin, grants no exception to reading, deleting or ingesting another
user's chat attachment, and another thread of the same user is not the current
thread. Task/wiki attachments remain project-bound. Model/conversion/history
loaders enforce the appropriate row-level boundary before accessing a shared blob;
content-addressing is storage dedupe, not authorization.

**Product statement:** Lexa is self-hosted project management, not a software
factory.

### Harness runtime — turn context, runs, schedules (ADR-0004) — retired (ADR-0005 W6)

> The ADR-0004 harness placement was DO-bound and is retired with the DO
> executor. In the in-process tier the turn context (agent instructions, ≤3
> `$skill` markdowns + catalog, the `project_memory` FTS block, doc/mention/repo
> context, the Jev advisory, the thread summary, tool descriptors) is assembled
> **in-process** by the assistant services — no internal `POST
> /api/internal/assistant/turn-context`, no `X-Lexa-Internal` HMAC, no signed
> identity. Compaction lives in `build-stream.ts` over D1 (`summary` /
> `summarized_count` on `assistant_threads`): past 40 messages or 64 KiB,
> everything outside the last-8-message window is condensed with one cheap
> `generateText`; a failure skips the event and the next persist retries.
>
> Delegation and scheduled execution were dropped (ADR-0005 D2/D3): no
> `LexaAssistantRunner`, `agents/agent-tools` dispatch, or `*/15` schedule drain.
> The `assistant_schedules` CRUD routes still create/update/delete schedule
> records, but no active executor converts due records into `assistant_runs`;
> the admin run read page remains.

**`workers_ai` (ADR-0005 D5/P5).** A model row with kind `workers_ai` uses the
OpenAI-compatible HTTP endpoint
(`https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`, `Authorization:
Bearer <CF API token>`) through `openaiCompatibleText` in
`server/assistant/provider.ts`, not a bound `env.AI` provider path;
a `workers_ai` provider row requires a non-empty base URL and stored Cloudflare
API token (save-time validation). The kind label remains for schema/labels/prices.

Call logs carry `thread_key`, `run_id`, and `purpose`
(`turn|runner|preflight|summary`), and `cost_cents` is computed from the CF
`ai/models/search` prices stored in `assistant_model_prices` when the caller
sends no explicit value. Provider success/failure is recorded by the in-process
gateway service (`assistant_provider_health`) between manual Test probes. The
former `wrapAISDK` tracing (`agents/observability/ai`, `server/assistant/tracing.ts`)
was deleted with the DO tier (ADR-0005 W6).

### MCP tool bridge (`server/assistant/mcp.ts`)

The Assistant consumes external MCP servers as **read-only** tools. A new SQLite
registry (`assistant_mcp_servers` + per-project `assistant_mcp_project_servers`,
superadmin-managed) holds transports; per stream run `buildMcpTools` connects
one `@tanstack/ai-mcp` client per globally+project-enabled server, discovers
tools, keeps only those annotated `readOnlyHint === true` (default-deny),
prefixes them `mcp__<serverId>__<tool>`, and appends them to the same `tools`
array the in-repo registry produces. Discovery is fail-open (`Promise.allSettled`
+ 5s per-server timeout); the toolset closes exactly once via
`StreamRunContext.onDispose` in `buildStream`'s `finally`. Every row is a
client of a **remote** MCP server: http/sse only, SSRF-validated at connect, and
`stdio` is not supported anywhere — see "Jev — System 1 advisory layer + MCP
Clients" below, which removes local stdio execution and migration 0010 deletes
the stored stdio registrations.

**No cycle (invariant #1).** The bridge is a plain assistant-tier module:
it imports the registry repo type, env/errors, the SSRF guard, the
`McpConnector` tag, and `@tanstack/ai-mcp` — never `GitHubService` or a
chat/task service. Chat/task services consume it, not the reverse. MCP tool
calls are not task mutations, so they emit no `task_activity` rows; v1 exposes
no write tools, and routing MCP writes through `assistant_pending_writes` is a
deliberate follow-up (it needs a rebuild migration).

### Jev — System 1 advisory layer + MCP Clients

**Status:** Accepted · **Date:** 2026-09-27 · **Decider:** maintainer ·
amended 2026-09-29 (env-only configuration → DB registry, official SDK transport).

Typesafe Jev is a typed System 1 judgment API, not a chat-completion provider or
an MCP endpoint. Lexa calls the official `@typesafe-ai/sdk` (`TypeSafeClient`,
pinned 0.6.0) against `{baseUrl}/v1/systemone` (default
`https://api.typesafe.ai`) with a Bearer key and `{ state, model, questions }`;
the API returns typed answers and usage, without chat messages or streaming.

**Configuration is a DB registry, not env.** The historical env-only Jev
variables were deleted. Three tables — `assistant_jev_config` (singleton: base
URL, model, enabled; migration `0013_jev_registry.sql`), `assistant_jev_secrets`
(the API key as AES-256-GCM ciphertext under the shared secrets keyring, scope
`jev`, AAD-bound to the config row), and `assistant_jev_projects` (per-project
opt-in; absence = disabled) — together decide whether Jev runs. The key is
**write-only** over the API: responses expose `hasKey`/`keyMask` and never the
blob, and it is opened only at request time by `AssistantJevService`. The project
read adds an additive `available` boolean (global enabled **and** a stored,
openable key, deliberately ignoring the project row) so a member without
superadmin read access can render the disabled toggle and the configure notice
without any key material. Jev does not enter `ProviderKind` or the MCP registry.

**Decision:** Jev has two advisory paths. Each new chat or task-assistant run
resolves the config once (`AssistantJevService.resolveForProject`) and gets one
bounded SDK preflight whose fixed typed judgments are added to the existing
assistant prompt. The assistant can also call a read-only `jev_assess` tool for
follow-up judgments. Neither path authorizes writes; existing assistant tool and
approval rules remain authoritative. Preflight fails open, and resumed streams do
not repeat it. Jev and the main model remain distinct: Jev supplies structured
judgment; the existing model produces the response and controls the tool loop.

Generic remote MCP integrations remain separate and support HTTP/SSE only.
Product-facing “MCP Servers” copy becomes “MCP Clients”; API routes and database
identifiers remain unchanged for compatibility. Local stdio support and the
seeded Jev MCP row are removed (migration 0010 deletes all stored stdio clients
and their project bindings). Legacy `command`/`args` columns and the historical
SQLite transport CHECK remain because the D1 migration path cannot drop columns
without a table rebuild; application validation accepts only HTTP/SSE. MCP client
credentials are envelope-encrypted managed tokens — the historical `env:`/`file:`
reference source, the fixed-`RuntimeEnv` allowlist, and the master-key denylist
were removed on 2026-09-28. See “Managed MCP client secrets” below.

**Data flow:**

```text
new run → AssistantJevService.resolveForProject (DB config + project opt-in + openable key)
  → bounded state + fixed questions → Jev SDK preflight (capping fetch)
  → advisory answers in system prompt → existing assistant stream/tool loop
  → optional jev_assess → advisory typed result → existing assistant decides
```

Preflight is capped at 3 seconds and 8,000 state characters; the callable tool
is capped at 3 calls per stream invocation, 10 seconds per request, and 4,000
state characters. Neither path logs request state or credentials. A missing or
undecryptable key, timeouts, rate limits, and upstream errors skip preflight or
return a typed tool failure without failing the assistant run. No task mutations
or `task_activity` rows are emitted.

**Implementation boundary.** `server/assistant/jev.ts` is a plain async module —
no Effect, no DB, no service edge — and `AssistantJevService` (over
`AssistantJevRepo`) is the Effect service that reads the registry and the
keyring. The chat/task services resolve the config and pass it into the module,
so **invariant #1 holds without a new rule**: `jev.ts` imports no repo or
service, and the service never depends on a chat/task service.

- **Registry resolution is total.** `resolveForProject(projectId)` requires
  global `enabled = 1`, an enabled project row, and a key that decrypts under the
  master key; any failure returns `null` and every caller fails open (advisory
  omitted, not an error). `projectAvailable()` is the same minus the project row;
  it backs the additive `available` on the project read.
- **Transport.** The SDK owns the request/response cycle, configured with our
  `cappingFetch`: the 64 KB cap covers **both** ok and non-ok bodies (a declared
  `content-length` short-circuits; a streaming byte counter cancels the reader at
  the cap). A 2xx over-cap body throws before the SDK buffers it; a non-ok body is
  capped and returned — the SDK needs one to build its error — without throwing,
  because an oversized error body is not a failure of its own. `retry: { maxRetries: 0 }`,
  a per-attempt `timeout`, and `logLevel: "off"` mirror the old single-attempt,
  hard-budget contract; the client is rebuilt per call from request-time DB
  values.
- **Typed failure vocabulary.** Every thrown SDK/transport error reduces to a
  fixed `{ ok: false, code }`: `MISSING_KEY | TIMEOUT | NETWORK | AUTH |
  RATE_LIMITED | INVALID_RESPONSE | HTTP_<status>` (401/403 → `AUTH`, 429/529 →
  `RATE_LIMITED`, a capping breach → `INVALID_RESPONSE`). No branch reads the
  error's own text, so upstream content and the key never reach a Lexa message.
  Every answer is re-validated and every question asked must come back answered.
- **Preflight flow (once per new run).** Both entry points
  (`runChatStream`, `runStream`) resolve the config and assemble the state from
  context the run has *already loaded* — run kind, project/thread identifiers and
  labels, the latest user message, the task/wiki context, project-memory hits —
  and await the verdict before `buildStream`, so the advisory is part of the
  prompt the model actually receives. History, attachments, and credentials are
  excluded by construction: the state builder's type is a whitelist with a fixed
  key order. The three fixed questions (write intent, ambiguity/missing fields,
  memory or prior-decision conflict) render as one clearly labeled
  non-authoritative block, and a conflict line carries its own deferral — live
  project data stays authoritative. **Resume** (`resumeChatStream`,
  `resumeThreadStream`) issues no preflight: the judgment was made against the
  original request. The `jev_assess` tool is still offered there, because its
  3-call budget is per stream invocation, not per run lifetime.
- **Callable flow.** `jev_assess` is added to the toolset only when the run
  resolved a config (a `null`/absent config omits it entirely), so a disabled Jev
  leaves the toolset unchanged. It accepts a bounded `state` plus typed
  `noul`/`choice`/`score` questions and returns typed answers and usage, or a
  typed `{ ok:false, code }`. It is read-only by construction: it reaches the
  same judgment endpoint and nothing else.
- **Bounds.** Preflight 3s / 8 000 state chars (ids 128, labels 200, each memory
  item 400, message 2 000, task/wiki context 4 000). Tool 10s per request,
  4 000 state chars, 8 questions, 3 calls per stream. Responses are read under a
  64 KB cap, and no call retries — a retry cannot fit the preflight budget, and
  both paths fail open on one attempt. Oversize *tool* input is refused with a
  typed `STATE_TOO_LARGE` rather than silently truncated, so a judgment is never
  computed over a state the model did not send. The preflight state is the only
  lossy path: clipped fields are marked with `…`, but the 8 000-char squeeze
  deletes the context or the message outright when neither fits, and drops
  memory items from the tail unmarked.
- **Fail-open, uniformly.** A missing/undecryptable key, a disabled global or
  project flag, timeout, transport error, 401/403, 429/529, an unreadable body,
  an oversized response, or an answer that does not match the question set yields
  no advisory block and no thrown error — the assistant run proceeds exactly as
  it would with Jev disabled. A failing tool returns a typed failure the model
  can read and route around. The one-line stderr log records only mode, outcome,
  failure code, latency, and token usage; a call that never reached the network
  logs no latency rather than a fabricated 0, and a `MISSING_KEY` preflight logs
  nothing at all — the disable switch is a deployment state, not a per-run event.
- **No write path, no cycle.** Jev can neither queue nor apply a write, so it
  emits no `task_activity` row (invariant #12) and cannot bypass the existing
  approval protocol — the advisory block states that in-band. `jev.ts` imports
  no repo or service, and `AssistantJevService` imports only the repo, the
  secrets module, and the error catalog: there is no edge for a cycle to form.

**Options rejected:** Jev as a chat provider is incompatible with its typed,
non-streaming API; Jev as an MCP client would require an undocumented hosted MCP
endpoint; local stdio wrappers are host-dependent and not the requested remote
integration. Env-only configuration (the original design) was
replaced because a Jev key belongs in the same encrypted, webapp-managed store as
every other provider credential. A callable-only integration leaves Jev use
dependent on the model's decision; automatic-only removes useful follow-up
judgments. Both advisory modes are retained.

### Managed MCP client secrets (envelope encryption)

**Status:** Accepted · **Date:** 2026-09-28 · **Decider:** maintainer
(extends "Jev — System 1 advisory layer + MCP Clients" above and the fixed-key
`secret_ref` contract superseded by managed secrets in `migrations/0011_mcp_managed_secrets.sql`
(see the MCP section of `docs/API.md`); assessed
with Jev — worth_cost 0.71, master_key_risk 0.32, security_sound closed at
level 2).

> **Amended 2026-09-28 — superseded in part.** The reference half of this
> decision (`env:`/`file:` `secret_ref`, the fixed-`RuntimeEnv` allowlist, the
> master-key denylist, the exactly-one-source XOR rule) was removed later the
> same day; the managed half stands unchanged. See "Managed-only MCP client
> secrets (2026-09-28)" below. The text that follows is the original accepted
> record, kept as history.

MCP Bearer tokens could only be **referenced** — `env:NAME` over the fixed
`RuntimeEnv` snapshot, `file:/abs/path` on the Bun host. They could not be
entered or managed from the webapp, and Cloudflare Workers had no usable
per-client auth path at all (no filesystem, and no per-client secret store).

**Decision:** a per-client token may be **entered** and is stored with envelope
encryption. A new table `assistant_mcp_secrets` (migration
`0011_mcp_managed_secrets.sql`, additive — `CREATE TABLE` only) holds
AES-256-GCM ciphertext, a per-write 12-byte IV, and `key_id`; the master key
lives **only** in the environment (`LXK_SECRETS_MASTER_KEY`, with
`LXK_SECRETS_MASTER_KEY_PREV` as the read-only rotation path). Existing `env:` /
`file:` references keep working unchanged. A client carries **exactly one**
source: a managed token XOR a `secret_ref`; carrying neither is a legal,
deliberately secret-less client, and storing one source deletes the other.

**Data flow:**

```text
superadmin save {secret} → exactly-one-source normalize → AES-256-GCM encrypt
  (fresh 12-byte IV, AAD binds the blob to the client id) → assistant_mcp_secrets row
assistant run → registry + secret row (one LEFT JOIN) → ciphertext? decrypt : resolve ref
  → single header check → Authorization: Bearer → remote MCP server
```

- **Ciphertext never enters the registry.** The blob lives only in its own
  table, so a bare `SELECT *` of `assistant_mcp_servers` can never surface one;
  the registry and the tool bridge read it through a `LEFT JOIN` and treat the
  **absence of a row** as "no managed token". A stored row is authoritative on
  read and short-circuits the reference branch, so a client can never send two
  credentials.
- **`key_id` is a keyring slot** (`active` / `prev`), never a fingerprint,
  counter, or date. That is what makes rotation rewrap-free: set
  `LXK_SECRETS_MASTER_KEY_PREV` to the old key, the active key to the new one,
  restart, and re-enter tokens over time — no outage, no rewrap pass, no data
  migration. An unfinished rotation is a warning, not a break.
- **The failure split is the point.** An unresolvable reference still connects
  with **no header** (unchanged fail-closed behavior). An **undecryptable
  ciphertext** is a hard `McpConnectFailed` — wrong key, tampered blob, unknown
  `key_id`, or a stored row on a deployment whose key is gone. A client that
  quietly authenticates as anonymous is indistinguishable from a working one, so
  silence is not an option here; every decrypt class reduces to one fixed
  message that quotes neither plaintext nor ciphertext. **That refusal reaches
  two different surfaces, and only one of them is a hard failure**: the registry
  test route reports it as a 502 `MCP_CONNECT_FAILED`, while an assistant run is
  fail-open (pre-existing bridge behavior) — the server is skipped with a stderr
  `WARN` and its tools are unavailable for that run.
- **Write-only, and cleared explicitly.** `secret` exists on the request schema
  and not on the response schema, so no response can carry a value. An empty
  `secret`/`secretRef` means **keep** — "empty means keep" is exactly why
  removal needs its own flag, `clearSecret: true`, which nulls the reference and
  deletes the blob. Clear is a pure row delete, so a credential can always be
  revoked even when the master key is gone.
- **Disabled without a key.** Unset `LXK_SECRETS_MASTER_KEY` is a documented disable
  switch: a managed save is refused with `MCP_INVALID_TRANSPORT_CONFIG`,
  references keep working, and an already-stored token is never dropped. A
  configured-but-malformed key is an error, never a silent disable.
- **Implementation boundary.** `server/assistant/secrets.ts` is a **plain
  assistant-tier module** — not an `Effect.Service`, importing only the
  `RuntimeEnv` *type* and Web Crypto, with no DB, no Node builtins, and no
  service edge at all, so **invariant #1 holds without a new rule**. It is
  scope-aware: the same module seals/opens MCP tokens (`mcp`), provider API keys
  (`provider`), and the Jev API key (`jev`), each bound to its owner through a
  frozen per-scope AAD prefix. AES-256-GCM
  is the only AEAD both Bun and workerd expose (no new dependency), keys import
  as non-extractable, and the master key is never in the DB, a backup, a
  response, or a log. Secret writes emit no `task_activity` rows (they are not
  task mutations).
- **The security claim rests on one operational rule** — see
  `docs/BACKUPS.md`: backups carry the ciphertext, and the master key must never
  be co-located with them. Set the key by hand in the environment (or
  `wrangler secret put` on Workers); it is never committed and never logged.

**Options rejected:** XChaCha20/ChaCha20 (unavailable on workerd, and a new WASM
dependency is not worth it); a rewrap endpoint (deferred — the `PREV` read path
ships now, and re-encrypting a row means re-entering the token); and a dedicated
`LXK_MCP_SECRET_*` namespace for referenced secrets (the fixed `RuntimeEnv`
snapshot plus a denylist for the master keys was approved instead, keeping the
existing `secret_ref` contract intact). The one-time asymmetry this record kept
— plaintext `assistant_providers.api_key` and `assistant_settings.search_api_key`
— was **partly closed later**: provider keys moved into the same envelope store
(migration `0014` + a one-way boot backfill; `assistant_settings.search_api_key`
remains plaintext, a separate open decision).

### Managed-only MCP client secrets (2026-09-28)

**Status:** Accepted · **Date:** 2026-09-28 · **Decider:** maintainer ·
supersedes the reference half of "Managed MCP client secrets (envelope
encryption)" above; the managed half is unchanged.

The two-source design (managed token XOR `secret_ref`) confused users and
forced XOR / allowlist / denylist machinery. **Decision:** the managed
envelope-encrypted token is the **only** credential source. `env:NAME` /
`file:/abs/path` references, `resolveSecretRef`, the fixed-`RuntimeEnv`
allowlist check, and the master-key denylist are removed end to end;
`LXK_SECRETS_MASTER_KEY` is now **required to store a token** (a secret-less client
remains legal).

- **No reference source, and no anonymous fallback.** Connect deleted the
  reference branch. A row that still holds a legacy `secret_ref` and no managed
  blob **hard-fails `McpConnectFailed`** instead of connecting with no
  `Authorization` header — an anonymous connect is indistinguishable from a
  working one, so the hard failure is the only safe reading. A genuinely
  secret-less client still connects header-less, by design.
- **Migration `0012_remove_mcp_secret_refs.sql`** clears every stored
  `secret_ref` with one value `UPDATE` (D1-safe, idempotent). The column is not
  dropped (D1 cannot), so it stays legacy and is never written again — every
  repo write nulls it.
- **`secretRef` is deprecated, accepted-and-ignored.** It stays on the wire
  POST/PATCH payloads so an older typed client still decodes instead of 400ing;
  a non-empty value emits one structured `WARN` and has no effect on the stored
  row.
- **`secretSource` narrows to `"managed" | "none"`** — a breaking response
  value (`"reference"` is gone). `hasSecret` is true exactly when a managed
  token is stored.
- **Deploy order:** run migration `0012` with, or before, the managed-only
  build. An old build on an un-migrated database would still resolve stored
  refs; after the migration every stored ref is null, and the connect path
  refuses any that somehow remain.
- **Unchanged from the original decision:** envelope encryption (AES-256-GCM,
  fresh IV, AAD-bound), the `active`/`prev` keyring slot and rewrap-free
  `LXK_SECRETS_MASTER_KEY_PREV` rotation, `clearSecret: true` as the only removal
  route (able to clear with no master key), write-only `secret`, ciphertext out
  of the registry, and the redaction rules.
- **Generalized to provider + Jev secrets (2026-09-29).** The same module, table
  shape, and keyring now also store **LLM provider API keys**
  (`assistant_provider_secrets`, migration `0014`, scope `provider`, AAD-bound to
  the provider id) and the **Jev API key** (`assistant_jev_secrets`, migration
  `0013`, scope `jev`). Provider keys are migrated by a **one-way boot backfill**
  (`server/db/provider-secrets-backfill.ts`): every non-empty
  `assistant_providers.api_key` is encrypted and the legacy column is then
  written `''`; with no keyring nothing is written and the blocked count is
  logged, so a credential is never cleared before a usable replacement exists.
  The backfill runs after the env mirror at Bun boot, and on Workers on the
  per-isolate first request (`ensureBoot`), idempotently. The legacy column
  survives this release dead and is dropped in the next.

### Removal record — the agent-runtime (Blacksmith) tier

The second tier, a coding-agent tier ("Blacksmith"), was removed end to end in
the same change that produced this section. Deleted: `machines`, `runtimes`,
`runtime_events`, `runtime_sessions`, `runtime_task_logs`; the
`/api/runtimes/*` non-assistant route group (daemon heartbeat/claim, machine
registry, warm sessions, run history, log feed, task create/cancel); the CLI
machine/runtime commands and the CLI's daemon embed; the machine listener, its
service-unit provisioning, the per-runtime daemon protocol, sandbox/workspace
provisioning, engine switching, and the `/runtimes` web shell. Renamed or
slimmed rather than dropped: `runtime_tasks` → `assistant_tasks` (trimmed),
`settings.runtime_repo_cap` → `assistant_repo_cap`, the agents/skills catalog
slimmed to the single builtin `assistant` agent, `assistant_settings` rebuilt
without `engine` / `engine_switcher_enabled`.

`docs/RUNTIMES.md` was deleted with it; every surviving assistant fact lives in
this section plus LAYERS.md.

**Naming history (kept for archaeology only, all of it gone):** Forge→Hearth
on 2026-08-24 (baked into the squashed `0001_init.sql` baseline),
Hearth→Runtimes on 2026-09-24 via `0005_runtime_rename.sql`, tier removal on
2026-09-26 via `0008_remove_agent_runtimes.sql`. Historical `runtime_*` activity
type names are retained only so pre-0008 timeline rows still render; new
emissions are `assistant_completed` / `assistant_failed` /
`assistant_cancelled` (invariant #12 — terminal emission stays inside the same
transaction as the status write).

### Reintroduction rule

Any future agent-runtime tier — a hosted coding agent, a per-machine daemon, a
warm session pool, an external queue consumer — requires:

1. a **new architecture decision recorded in this file** (not a config toggle,
   not a follow-up doc), and
2. a **security review** covering how the runner authenticates, what it can
   reach, and what it can do to a workspace.

Specifically, it must not casually resurrect the removed auth model: no
`x-runtime-token` header, no `LXK_RUNTIME_DAEMON_TOKEN`, no per-daemon shared
secret minted outside the `lxk_` API-key system. And it must not create a
service dependency cycle of the kind invariant #1 forbids — a
`TaskService → GitHubService`-style cycle, or an AI-tier service reaching into
GitHub/task services in a way that makes the DAG untestable. Route
orchestration stays in handlers.

Rationale for the removal: the coding-agent tier was a software-factory
capability bolted onto a project-management product. It owned a large
operational surface (machine/deployment ops, an HTTP daemon protocol, sandbox
provisioning, engine switching) that had to be maintained, secured, and
documented, for a product whose job is the board and the wiki.

**Consequences:** assistant features ship with the web app (deploy = bundle +
one settings row); token streaming, tools, memory, multimodal become direct API
surface; provider/vendor swap is a settings edit; Worker-portable by
construction (no child processes anywhere in the AI path); feature velocity —
most changes touch prompt/tool rows, not plumbing. A killed turn persists its
partial output incrementally; a crash mid-stream can leave an `assistant_tasks`
row `running`. The backstop is `server/assistant/stale-runs.ts`
(`sweepStaleAssistantTasks`, 30-minute bound over `COALESCE(started_at,
created_at)`), called fire-and-forget at both boots (`server/entry.ts`,
`server/workers-entry.ts` `ensureBoot`) — it fails stale `running` rows so
reset/resume is never blocked. Residual: a row stranded while the process stays
up is only swept at the next boot.

**Accepted risks:** TanStack AI is 0.x — pinned exact versions, `chat()`
imported in exactly one service (`server/assistant/provider.ts`); upgrades are
deliberate acts. The catalog is load-bearing — prompt quality depends on
curated Lexa Agents/Skills rows (size discipline required). API keys held
server-side plaintext (accepted for the self-hosted threat model). Table
renames fail at runtime, not compile time — gated by atomic migration plus
mandatory repo/service test suites.

**Catalog (kept, slimmed):** `lexa_agents` / `lexa_skills` /
`lexa_agent_skills` with routes `/api/agents` + `/api/skills`; per-agent skill
availability is the junction rows only (admin-editable, no JSON columns); the
single builtin `assistant` agent renders the catalog into the system prompt.
`AGENT_ENTITY_IN_USE` delete guard survives and now counts `assistant_tasks`.

**Vision chain:** a configured per-project `vision_model` (revived by migration
0028) drives the current phase — images always route through the vision agent
(the internal `analyze_image` delegation), even when the primary is multimodal.
Without a vision model, `primary_supports_images=1` would inline image parts
(the later target); otherwise attachments are rejected up front with 409
`VISION_NOT_CONFIGURED`.

**Assistant service concern split (accepted 2026-08-27; formerly a standalone
ADR, merged here):**

`server/services/assistant.service.ts` handled both freeform chat
(`runChatStream`/`resumeChatStream`, `activeChats`, `MAX_CHAT_TOOL_ROUNDS=24`)
and task/wiki doc streams (`runStream`/`resumeThreadStream`, `activeTasks`,
`MAX_TOOL_ROUNDS=12`, queue+approvals, writeTools drain) plus shared
`buildStream`, stall watchdog, and truncated tool-args salvage. The coupling
let a chat stall block the task-queue tests and made round caps/registries
indistinguishable. Split into two Effect services behind a thin facade:

- `server/services/assistant-chat.service.ts` — `AssistantChatService`
  (`Lexa/AssistantChatService`): `activeChats`, `MAX_CHAT_TOOL_ROUNDS=24`, chat
  stream, resume, listChats, updateChatMeta, decideApproval, abortChat.
  Depends on repos/gateway/storage only; write-tool drain optional.
- `server/services/assistant-task.service.ts` — `AssistantTaskService`
  (`Lexa/AssistantTaskService`): `activeTasks`, `MAX_TOOL_ROUNDS=12`, enqueue,
  runStream, resumeThreadStream, decideApproval, abortStream. Owns the
  queue/approval drain.
- `server/assistant/build-stream.ts` — shared `buildStream` factory
  (`StreamRunContext` → `ReadableStream<StreamFrame>`) with
  `STREAM_STALL_TIMEOUT_MS=90s`, `shouldEmitToolFrame`, `stripToolCallXml`,
  `findPendingBatch`/`applyResumeResults`. Chat/task instantiate it with their
  own `toolRoundCap`/`registry`; core loop/stall/salvage logic is not
  duplicated.
- `server/services/assistant-helpers.ts` — pure helpers (`scanMentionTokens`,
  `resolveAssistantThread`, `buildChatSnippet`, …) re-exported via the facade so
  `import { buildStream } from "./assistant.service"` tests keep passing.
- `server/services/assistant.service.ts` — thin facade `AssistantService`
  (`Lexa/Assistant`) delegating to chat/task, preserving
  `import { AssistantService }` for `server/api/http.ts` (no route change).
  `decideApproval` fans out to both (shared `pendingWrites` table).

Alternatives rejected: single service with internal branching (caps/registries
stay coupled); full `buildStream` duplication per service (hotfix drift);
moving `decideApproval` entirely to one side (`pendingWrites` serves both
docTypes). Frontend cache keys are already separate
(`["assistant-chats",projectId]` vs
`["assistant-thread",projectId,docType,docId]`) — no change. No DB migration, no
new service cycle (`Assistant*` → repos/gateway only; the `TaskService` →
`GitHubService` cycle is unchanged). Phase A hotfixes preserved (tool-args
salvage of `{"name":"v1","dueAt":` → skip with `ASSISTANT_TOOL_ARGS_INVALID`,
stall watchdog, 404 demote).

**Consequences:** `activeChats`/`activeTasks` isolated — a chat stall cannot
block the task queue; facade keeps existing imports green; future routes can
import `AssistantChatService`/`AssistantTaskService` directly. Deviation:
`Assistant*Service` depends on `TaskService`/`CommentService`/etc. for
approved-write execution, so `grep -r "TaskService" server/services/assistant-*.ts`
hits via class/tag name and the write executor — not a `TaskService` →
`GitHubService` cycle; that no-service-cycle invariant is preserved.

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
/settings/team             → team profile, members, projects (team admin)
/settings/project/:projectId → project settings hub (admin; Assistant provider, write tools, memory, skill availability)
/settings/workspace        → members, invites, teams, API keys, rate limits, GitHub, Assistant (superadmin)
/admin/assistant            → Assistant control panel (superadmin) — tabbed shell + Overview (KPI, gateway health, recent runs, bindings summary)
/admin/assistant/providers  → Assistant provider + model registry CRUD (superadmin)
/admin/assistant/agents     → Assistant agents + skills (superadmin)
/admin/assistant/usage      → Assistant usage + cost reporting (superadmin)
/admin/assistant/runs       → Recent assistant runs (superadmin)
/admin/assistant/bindings   → Per-project assistant bindings overview (superadmin)
```

Key components: `KanbanBoard` (swimlanes → columns → task cards, inline add, settings modal), `TaskDetail` slideover (title/description editors, property bar, GitHub section), `WikiLayout` (nested collapsible sidebar + Markdown source/preview page), `Dashboard` (project cards with health dots, WIP bars, stats, attention sections).

### Mutation responses are authoritative
SQLite is local (WAL) so reads are immediate, but the mutation response is still the single source of truth. Rule: **mutations return the updated entity and TanStack Query updates its cache from the mutation response (`setQueryData`) — no refetch on the mutation path.** Invariant #6 preserved.

### Effect Mid (frontend app routes, 3.22 — SPA only)
Effect-TS 3.22 on the frontend app routes is limited to **Mid**: Effect lives under `queryFn` only, no global `Runtime`, no SSR Effect. Client-only `app/lib/effect-api.ts` (`effectFetch` → `Schema.decodeUnknownSync` via `shared/schema.ts` decode) consumed inside TanStack Query `queryFn`/`mutationFn`; Assistant path runs through this client-only boundary. Workers app routes inherit the same client-only boundary. The one server-side exception is `/share/$token` SSR: `app/lib/share.server.ts` runs `WikiShareService.resolvePublic` through a per-flavor `ManagedRuntime` (Bun `bun:sqlite` / Workers D1 via `cloudflare:workers` env) — not through `effect-api.ts`.

## Hosting flavors

Two flavors share the same source tree, but they are no longer peer-level in
active development: **Cloudflare Workers is the only actively developed deploy
target; the Bun standalone flavor is frozen at its current features** (existing
installs keep running, no new work lands there — see ADR-0003). There is no data
sync between flavors; migrate Bun→Workers by dumping the Bun DB to SQL and
replaying on D1:

- **Cloudflare Workers (actively developed target, $5/mo):** Workers + D1 + R2 + KV.
  Same model: `/share/*` → the Start SSR handler, with the share lookup backed
  by D1 (`cloudflare:workers` `env.DB` → `DbD1Live` in `app/lib/share.server.ts`);
  other non-API routes → the prerendered shell. The generated worker config has
  no assets binding, so the shell-cache path is inert today and the worker falls
  back to the Start handler (full root document per response;
  `injectEntryScript` is applied per response, never cached globally). Same
  routes and services, different drivers: `server/db/drivers/bun-sqlite.ts`
  vs `server/db/drivers/d1.ts` (repos async; bun-sqlite wraps sync API in
  `Promise.resolve`), R2 native binding driver vs `fs`/`s3`, `RuntimeEnv`
  (`process.env` on Bun vs `env` from `cloudflare:workers` on Workers),
  `createAuth(env)`, `wrangler d1 migrations`, scheduled `*/15` prune/retention
  only (expired webhook/device-login records and backup retention; not snapshot
  creation or assistant schedule execution).
  Atomicity invariants (emission + webhook) re-expressed as `db.batch()` arrays;
  read-dependent sites fold the read into the batch SQL or carry an explicit
  read-compute-retry window.
- **Bun standalone (frozen at current features):** `Bun.serve` + `bun:sqlite` (WAL)
  + cloudflared tunnel. `server/entry.ts` serves the prerendered SPA shell
  (`_shell.html`) directly for every route except `/api/*`, `/health`, `/assets/*`
  and `/favicon*` (all handled earlier) and `/share/*`, which runs the Start SSR
  handler (loader + `head` server-rendered → title/OG/description). A missing
  `_shell.html` falls through to the legacy `/` landing page /
  `dist/client/index.html`. Root is `ssr: true`; the authed/app routes declare
  `ssr: false` and stay client-only. Frozen at current features (ADR-0003):
  existing installs keep running, no new work lands there, and the assistant is
  available on this flavor via the default request-bound in-process SSE path.
  Development runs from a clone

Vite plugin chain emits two server bundles (Bun entry + Workers entry).
Dispatch point: `curl -fsSL …/scripts/install.sh | bash -s -- workers` (the installer's only target).
Compliance gate: `scripts/check-invariants.ts` scans for the 14 invariants.
Full Workers HOW: `docs/CLOUDFLARE_WORKERS.md` (decision formerly ADR-0002,
now merged there); deploy flows: `docs/DEPLOYMENT.md`.

## ADR-0007: Markdown is canonical document content

**Status:** Accepted  
**Date:** 2026-10-14  
**Deciders:** Project owner

### Context

Task descriptions, wiki pages and revisions, and task comments were persisted as TipTap JSON despite editing, GitHub sync, assistant tools, and document imports using Markdown. Parse/serialize round trips can lose source. Public contracts and storage must move together; unknown legacy structures cannot be silently discarded.

### Decision

- Store `Task.description`, `WikiPage.content`, wiki revision `content`, and comment `body` as Markdown strings at existing field names, routes, and response envelopes.
- Store submitted source exactly; do not parse and reserialize on writes. New document defaults are `""`.
- Use `markdownToText` only for readable projections/search/snippets; it omits image alt text, matching the existing plain-text projection. `isMarkdownEmpty` owns task required-field validation. Visible text, nonempty code, safe images, horizontal rules, and tables with meaningful cell content count as meaningful. Formatting-only and whitespace-only source, empty task-list markers, unsafe images, and empty table structure do not. Comments additionally require non-whitespace text and preserve `JSON.stringify(body).length <= 65,536` JavaScript characters.
- Keep `normalizeMarkdownForEcho` solely for GitHub boundary comparison (trim and CRLF normalization).
- Render with `@tanstack/markdown` 1.0.0; CodeMirror packages are pinned at `@uiw/react-codemirror` 4.25.12 and `@codemirror/lang-markdown` 6.5.2. HTML input is rendered as escaped text; `javascript:` links are removed. ATX headings, task lists, and tables render. Setext headings remain paragraphs, indented code is a paragraph, bare URLs do not autolink, two-space hard breaks are not `<br>` (backslash-newline is), partial fences stay safe, and an incomplete `# ` heading emits nothing. Preserve source where display syntax differs; do not add a second general parser/compiler.
- Declare the editor's already-bundled public core APIs explicitly: `@codemirror/state` 6.7.6 and `@codemirror/language` 6.13.1. Code context comes from the native incremental grammar, not another fence scanner. Keep the incumbent authenticated route `ssr: false` boundaries; the public share renderer does not mount an editor.
- Keep render profiles explicit. Task/comment prose reuses existing per-element classes, wiki/share reuse their wrappers and focusable anchors, and headings cap at h4 in both rendered output and outline levels. Preserve checklist markup and chat code chrome/caret. Comments retain external-only links and do not load images; chat images remain alt text; authenticated document images and token-scoped public share rewriting retain their existing policies.
- CodeMirror inherits PHOSPHOR fonts, geometry, selection and caret colours rather than its default themed chrome. Source, toolbar, save and review read the same current Markdown value. Schedule cursor-popup measurements with `requestMeasure`; native IME commits must not be cancelled by the editor's handled-key path.
- Convert legacy TipTap data only in explicit offline operator tooling. Preserve supported Markdown meaning and literal source characters; refuse malformed or unsupported structures rather than dropping or inventing content. Audit blockers remain visible for operator resolution. Task mentions map to `/{slug}/board?task={id}` and wiki mentions to `/{slug}/wiki/{pageSlug}` only when target and label are valid.
- Chat document conversion is optional in the existing Workers runtime: the configured AI binding handles PDF and DOCX; Markdown/MD/TXT bypass it and require strict UTF-8. Other accepted binary formats can fail explicitly if the managed service cannot convert them. No local converter fallback, automatic persistence, second Worker, or replacement of REST model-provider configuration. Existing image signatures and vision flow stay unchanged.
- Preserve IDs, authors, timestamps, ordering, soft-delete state, revisions, comments, and historical audit data. Convert document-bearing pending proposals with arguments/diffs; already-applied history remains immutable.
- Migration `0030` establishes setting `settings.key='documents.format'`: empty new databases and databases with no four-table or active proposal rows start `markdown-v1`; existing content starts `tiptap-v1`. The only states are `tiptap-v1`, `migrating-markdown-v1`, and `markdown-v1`.
- Durable table `_markdown_migration(table_name, row_key, source_hash, target_hash)` has `(table_name,row_key)` primary key and contains hashes only, never document bodies. Each bounded batch CAS-updates source rows and inserts matching journal hashes atomically. A changed source, hash mismatch, or incomplete target verification blocks completion.
- Count affected source/journal rows from SQL `RETURNING`, not driver change metadata that may include FTS trigger writes or be absent from local Wrangler JSON. SQLite audits open read-only and skip journal-mode changes. Local D1 restore evidence may use a verified SQLite snapshot of its selected persistence directory; remote D1 still requires a D1 export, never that local snapshot.
- After verification, apply sets `documents.format` to `markdown-v1`; reapply checks that setting and never parses JSON-looking Markdown. `server/db/document-format.ts` exports Worker-safe `assertMarkdownReady(db: DbDriver): Effect.Effect<void, DbError>`; API factories/middleware must reject traffic unless value is `markdown-v1`. The format guard does not convert data.
Historically applied SQL migrations remain immutable. `0030` uses D1-supported column replacement to set task/wiki empty defaults; application creation paths still explicitly write `""`. Operators follow `docs/BACKUPS.md`: stop writers, take and verify a restorable database/blob backup, audit and resolve blockers, apply with matching backup evidence, verify format/projections, then reopen traffic. Rollback restores the matching pre-upgrade backup and application version.

### Options considered

**Keep TipTap JSON:** avoids a breaking API change, but perpetuates conversion code and makes source round trips lossy.

**Store both TipTap and Markdown:** avoids immediate cutover but creates competing canonical values and synchronization failure modes.

**Canonical Markdown (selected):** aligns storage and existing source-editing/sync formats, removes routine conversions, and requires a guarded one-time migration.

### Consequences

- REST fields retain names/routes but become strings; legacy object payloads are rejected after coordinated cutover.
- FTS text is regenerated from Markdown and maintained by existing wiki triggers; source remains unchanged.
- Unsupported legacy rows block migration rather than losing content. Application rollout waits for format-complete guard.
- Old binaries cannot safely read converted data; rollback restores the matching pre-upgrade backup with writes stopped.

## File Structure

```
lexa/
├── app/                      # TanStack Start routes + components
│   ├── routes/               # dashboard, kanban, tasks, milestones, swimlanes, wiki, settings, admin
│   ├── components/           # activity/, assistant/, auth/, kanban/, layout/, milestones/, settings/, swimlanes/, ui/, wiki/ + flat task components (TaskDetail.tsx, TaskPropertyBar.tsx, TaskTitleInput.tsx)
│   └── lib/                  # api.ts, queries.ts
├── server/                   # Effect-TS services
│   ├── entry.ts              # Bun.serve — boot, webhook, static/SPA fallback, /api stream cap + IP stamp
│   ├── auth.ts               # Better Auth instance (credentials + organization + tanstackStartCookies)
│   ├── api/                  # HttpApi app (http.ts), middleware.ts (rate/auth/headers), auth-key.ts, auth.ts, errors.ts, limits.ts
│   ├── services/             # task, project, wiki, column, swimlane, session, authorization, workspace-invites, password-links, ...
│   ├── repos/                # task.repo.ts, project.repo.ts, ...
│   ├── db/                   # database.ts (bun:sqlite layer), migrate.ts, document-format.ts, markdown-upgrade.ts, legacy-tiptap.ts
│   └── github/               # GitHub App client + webhook
├── shared/                   # types + pure functions (Markdown, positions)
├── migrations/               # *.sql; schema only (document conversion is explicit operator work)
├── cli/                      # lx (operator CLI; task/wiki/project/github/keys — no deploy, no daemon)
├── scripts/                  # migrate-markdown.ts, compile-cli.ts, dev.sh, install-cli-dev.sh, install-cli.sh, prepare-effect.sh, seed-dev.sql, setup-cli.ts
├── wireframes/               # git submodule → private repo yohanesgre/lexa-wireframes
└── package.json
```
`wireframes/` is a git submodule pointing at the separate PRIVATE repo `yohanesgre/lexa-wireframes` (init with `git submodule update --init wireframes`) — see AGENTS.md.

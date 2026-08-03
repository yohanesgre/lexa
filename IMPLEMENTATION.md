# Lexa — Implementation Plan (executor edition)

> **Audience:** a coding agent that did NOT participate in the design. This document is self-sufficient.
> **Mission:** implement Lexa, a self-hosted PM tool (kanban + tasks + nested wiki + MCP server for AI agents + GitHub sync), exactly as designed.
> **Rule zero:** the design docs in this directory are the source of truth. Where this plan and a design doc disagree, **stop and report the conflict — do not improvise.**

## Source-of-truth documents (read before writing any code)

| File | Read for |
|------|----------|
| `SCHEMA.md` | Full SQL (copy it verbatim for the migration), fractional-index rules, atomic-move SQL |
| `LAYERS.md` | Effect service patterns, error catalog, webhook flow, auth |
| `API.md` | Every REST endpoint, entity TypeScript types, error envelope |
| `MCP.md` | Tool list, I/O schemas, Markdown-at-boundary rule, agent ergonomics |
| `DESIGN_SYSTEM.md` | PHOSPHOR tokens, Tailwind mapping, component specs |
| `ARCHITECTURE.md` | Big picture, decisions log |
| `wireframes/` | HTML/CSS previews of every screen — match their structure |

## Hard rules for the implementer

1. Do not add features, tables, endpoints, or tools not present in the design docs. Do not rename anything.
2. Copy SQL from `SCHEMA.md` verbatim. Copy error codes from the catalog verbatim.
3. Never re-derive algorithms that are specified here (position generation, WIP check, webhook flow, markdown conversion) — implement them as written.
4. After EVERY phase: run `tsc --noEmit`, run that phase's acceptance checks, and paste outputs. Do not start the next phase until they pass.
5. Do not commit unless the user explicitly asks.
6. No comments in code unless the behavior is genuinely non-obvious.
7. If a package/API named here doesn't exist in the installed version, adapt minimally and note the deviation in your reply. Never silently substitute a different architecture.
8. TypeScript strict mode everywhere. No `any` outside JSON-payload boundaries (cast immediately at the boundary).

## Decisions already made (do not revisit)

- One Bun process (`server/entry.ts`) serves SSR frontend + REST API + MCP + webhooks via `Bun.serve` on port 3000.
- REST is one Effect `@effect/platform/HttpApi` app (`server/api/http.ts`); `server/entry.ts` routes `/api/*` to it.
- Repos use the **raw bun:sqlite API** (prepared statements: `prepare/run/get/all`) wrapped in Effect — no ORM, no query builder (deterministic, version-proof).
- MCP is **stateless Streamable HTTP**: POST-only JSON-RPC 2.0 for exactly these methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- GitHub calls are hand-rolled `fetch` (3 endpoints only) — no Octokit dependency.
- Auth: Cloudflare Access for humans (configured in the CF dashboard; identity arrives as `Cf-Access-Authenticated-User-Email` headers through the cloudflared tunnel), `lxk_` Bearer keys for machines. There is NO login page, NO session code.
- Markdown↔TipTap conversion is a hand-rolled pure module (`shared/markdown.ts`) over a defined subset — no DOM-dependent libraries.
- Runtime: **Bun standalone** (not Cloudflare Workers). SQLite via `bun:sqlite` (WAL), migrations applied on boot by `server/db/migrate.ts`. Deploy: Docker Compose + cloudflared tunnel via `scripts/setup.sh <domain> [dev|staging|prod]`.

---

## Completed phases (0–5)

Phases 0–5 are implemented and merged: Bun scaffold, SQLite schema + repos/services, Kanban CRUD (atomic move, WIP, required_fields, `/board`), frontend core (dashboard, board, task detail), wiki (FTS search, markdown module, TipTap editor), and the MCP server (33 tools, API-key auth). Remaining work below.

**Setup/install (2026-07-31):** added the fullstack install wizard — `bun run setup` (CLI: admin email, API key, migrations, seed toggle) and the first-run web wizard at `/setup` (admin email, API key generation, sample-data toggle; `/api/setup/*` is API-key exempt). Admin emails persist in the `settings` KV table (env OR settings in `server/api/auth.ts`). Boot-time seeding is opt-in via `LXK_SEED_DEV=1`; the wizard owns sample data. See AGENTS.md "Running the dev stack".

**Task archive (2026-08-01):** soft-archive via `tasks.archived_at` (migration `0009_task_archive.sql`). `POST /archive` + `/restore` endpoints (idempotent), `?includeArchived` on `/board`, MCP `archive_task`/`restore_task` tools + `list_tasks includeArchived`. Archived tasks keep column/position, are excluded from WIP/count/board queries, and render dimmed + non-draggable with a "Show archived" toggle (card kebab + TaskDetail footer actions). Delete is untouched. Docs: API.md, MCP.md, LAYERS.md, SCHEMA.md.

**Task field options (2026-08-01):** per-project customizable priority/type. `priority_options`/`type_options` tables (migration `0010_task_field_options.sql`, backfills legacy enums 1:1); `tasks.priority`/`type` are now option IDs. `GET/PUT /api/projects/:slug/field-config` (PUT is a full replace with `OPTION_IN_USE` 409 on deleting a used option, `INVALID_OPTION` 422 on bad ids/dupes/empty); `/board` carries `fieldConfig`. Board Settings modal gains Priorities + Types sections (add/edit/delete/drag-reorder; first option = create default). MCP speaks labels: `get_project` lists priorities/types, `create_task`/`update_task`/`list_tasks` accept labels case-insensitively and return labels + ids in TaskSummary. Dashboard "urgent" now = the project's first priority option. Docs: SCHEMA.md, API.md, MCP.md, LAYERS.md, DESIGN_SYSTEM.md, wireframes.

**Forge — runtime agent writing assistant (2026-08-01):** multica-style daemon runtime. Migration `0011_forge_runtimes.sql`: `runtimes`, `forge_tasks` (queued→running→completed/failed), `document_sources` (persisted wiki/external sources). `/api/forge/*` — runtime register/heartbeat/claim, task create/get/complete/fail (daemon auth via `LXK_FORGE_DAEMON_TOKEN` x-forge-token or Bearer); `document_sources` CRUD per document. `scripts/forge/daemon.ts` (`bun run forge:daemon`) polls, spawns `opencode --print`/hermes per task in a temp workdir, reports result. Sources: wiki pages resolved server-side, external URLs fetched with SSRF guard (private/loopback/CGNAT blocked, `server/forge-ssrf.ts` + tests). Frontend: Forge popover in the shared editor toolbar (actions, sources, streaming result, Accept replaces selection/inserts at cursor), Sources section on TaskDetail + WikiPageViewer. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, BACKLOG.md, wireframes (forge-popover.html). Out of scope v1: skills marketplace, autopilots, resumable sessions, daemon on prod docker, agents-on-the-board assignment UI.

**Forge machine setup (2026-08-03):** `lexa-cli machine listen` registers a machine and owns per-runtime daemon children. The web wizard sends only machine + agent CLI + a fresh key; provider/model, agent persona, logging, and extra args are configured after setup from Settings. The listener reports installed CLI agent/model catalogs with machine heartbeats. Offline runtime removal is blocked; online removal queues a machine-scoped despawn event before deleting the runtime row. Migrations `0023_runtime_setup_events.sql` through `0026_runtime_agents_catalog.sql` add the machine registry, event contract, runtime link, and agent catalog.

**Forge agents + skills (2026-08-03):** the fixed action enum becomes global rule bundles. Migration `0027_forge_agents_skills.sql`: `forge_agents` (builtin **Lexa**), `forge_skills` (builtins Continue/Rewrite/Summarize/Expand/Fix grammar, seeded from the old ACTION_PROMPTS), `forge_agent_skills` M2M bindings (Lexa ↔ all 5), and `forge_tasks.action` → `agent_id` + `skill_id` + `extra_prompt` (table rebuild, backfill by action, agent → 'lexa'). Delivery is **files-only, claim-carried**: the claim response carries `agentMarkdown`/`skillMarkdown`; the daemon writes them into the run dir as `AGENTS.md` + `.agents/<skill>/SKILL.md` (CLI-native discovery — no host store, no sync layer, edits apply to the next run). The prompt carries task context + output contract + the per-run `extra_prompt` + a pointer line only. Settings gains Agents + Skills sections (editor modal: name/description/mono instructions/file preview, builtin Reset / custom Delete, agent attached-skills checkboxes); the Forge popover picks Agent → dependent Skill (defaults Lexa/Continue) + additional prompt; control panel filter becomes All skills. Runtime rows relabel "Agent" → "CLI" and "Agent persona" → "Persona" (labels only — kills the name collision with the new agents). **Machine state root:** everything the host stores moves under `~/.lexa/` (`LEXA_DIR`): `config.json`, `machine-id`, `env`, `runtimes/<id>/env`, `runs/<taskId>/` (ephemeral workdirs — explicit cleanup after every run). The listener + `lexa-cli login` migrate the legacy `~/.config/lexa-cli` / `~/.config/lexa-forge` dirs into it — migrate-and-delete, no fallback. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, BACKLOG.md, wireframes (settings-agents-skills.html, forge-popover.html). Out of scope: artifacts/retention, memory files, SKILL.md assets, per-agent access, agent→runtime binding, per-project agents/skills, sync-health notifications (drift is impossible by construction).

**Task links — subtasks / blocked-by / related (2026-08-01):** one directed `task_links` table (migration `0012_task_links.sql`, relation `subtask_of|blocked_by|related_to`). Deliberately reverses the v1 "cut subtasks" YAGNI — semantics now defined (REVIEW.md noted "undefined semantics, UX cost"; this defines them). Subtasks: children inherit the parent's column, `POST /tasks` gains `parentId`, moving a parent cascades to children, cycle guard (`TASK_LINK_CYCLE`). Blocked-by: informational amber dot + tooltip (no move guard). Related-to: symmetric display. `GET/POST/DELETE /api/projects/:slug/tasks/:id/links` + `GET /tasks/search?q&exclude` (@-autocomplete: title LIKE, cap 10, excludes self). Board carries `links` for grouping. Frontend: parent cards show chevron + count with indented child cards (kanban-card-subtask), Links section with @-autocomplete + relation dropdown on TaskDetail. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, BACKLOG.md, REVIEW.md, wireframes.

**Forge control panel (2026-08-03):** global `/forge` page listing every Forge task across projects, newest first — summary strip (per-status counts ride the history response; no separate aggregate endpoint), status-chip + project + action filters, keyset-paginated task table, and a 520px task-record slideover (meta grid, live activity log, Markdown result / error box). Backend: `GET /api/forge/tasks/history` (`ForgeTaskHistoryResponse` with `data + nextCursor + summary`; repo `listHistory` keyset on `(created_at, id)` DESC with `document_title` CASE subquery + INNER JOIN projects, `countByStatus` for the summary). Client: `listForgeTaskHistory` + `useForgeTaskHistory` (polls 1.5s while any page row is queued/running, 15s idle); `useCancelForgeTask` also patches cached history pages via `setQueriesData`. Navbar Forge pill gains a "Forge control panel" item. Wireframe-first: `wireframes/src/forge-control-panel.html` (registered in index.html + navbar partial). Docs: API.md, DESIGN_SYSTEM.md §5.9m, wireframes. Out of scope: per-filter summaries, live totals across pages, result rendering as HTML (Markdown shown raw, read-only).

---

# Phase 6 — GitHub sync

### 6.1 Manual steps (USER does these — pause and hand off)

1. GitHub → Settings → Developer settings → New GitHub App: name `lexa-<instance>`, webhook URL `https://<host>/api/webhooks/github`, webhook secret (generate), permissions **Issues: Read & Write**, **Metadata: Read**, subscribe to **Issues** events only.
2. Generate private key (PEM). Install the app on the target repo(s); note the installation ID (`github.com/settings/installations`).
3. Set env vars `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` — in `.env` for dev, in docker-compose/`scripts/setup.sh` for deploy.

### 6.2 `server/github/client.ts` (per LAYERS.md §Infrastructure)

- App JWT: RS256 via Web Crypto (`importKey` pkcs8, `sign`), claims `{ iat: now-60, exp: now+540, iss: APP_ID }`.
- Installation token: `POST /app/installations/{id}/access_tokens` with the JWT → token (1h TTL). **Module-scope cache** `Map<installationId, { token, expiresAt }>` with 50-min refresh (NOT inside any Effect layer — see LAYERS.md note).
- Endpoints (raw fetch, installation token): `POST /repos/{repo}/issues`, `PATCH /repos/{repo}/issues/{n}` (state), `GET /repos/{repo}/issues/{n}`.
- `verifyWebhookSignature(rawBody: ArrayBuffer, header: string)`: HMAC-SHA-256 via Web Crypto over raw bytes, hex-compare `sha256=...`, constant-time.

### 6.3 `GitHubService` + webhook route

Implement LAYERS.md §GitHubService **line by line**: `syncStateFromLexa` (task.githubRepo, non-blocking caller pattern), `createLinkedIssue` (already-linked guard, store `repo`), `handleWebhook` — signature verify BEFORE parse (route-level, raw body), `isSeen` pre-check, event filter, `findByGithubIssue`, edited→title sync, echo suppression via `githubSyncedState`, column by `githubState` mapping, `moveFromWebhook`, `recordDelivery` AFTER success. Webhook route: 200 immediately, processing in the background (fire-and-forget after responding — Bun has no `waitUntil`; structure the handler so ack and processing are separable). No auth middleware on this route (HMAC is the auth).

Link endpoints (`POST/DELETE /api/projects/:slug/tasks/:id/github-link`) per API.md. Orchestration in the move route handler: after successful `TaskService.move`, if `column.githubState && task.github` → `syncStateFromLexa` with `catchTag(GithubApiError → logWarning)`.

Webhook-event pruning (`WebhookEventRepo.prune(7)`) runs on a timer or on boot — the daily Cloudflare cron no longer exists.

### 6.4 Acceptance

Move a linked task to the Done-mapped column → GitHub issue closes within seconds; the resulting webhook does NOT re-trigger a move (echo suppressed — verify in logs). Close the issue on GitHub → task lands in the mapped column. Kill the server mid-process (or force a DbError) → GitHub retries → event eventually processed (delivery not pre-recorded). Bad-signature POST → 401.

---

# Phase 7 — Ship

Remaining work (Settings UI, board polish, and swimlane collapse persistence are already implemented):

1. **Access (USER, CF dashboard)**: Access application on the hostname, email allowlist; **bypass policies for `/mcp` and `/api/webhooks/*`** (the tunnel fronts the Bun server; no `workers.dev` route exists). Identity arrives as `Cf-Access-Authenticated-User-Email` headers → `server/api/auth.ts` upserts user records.
2. Wire the remaining error→status mappings to the full catalog; re-run acceptance checks; `tsc --noEmit`; `vitest run`; `docker compose up -d --build` (or `scripts/setup.sh <domain> prod`).
3. **Final checklist** (paste results): all acceptance blocks green; OpenCode MCP session completes the §5.4 script against production; one full GitHub round-trip on production.

---

# Appendix A — Error catalog (copy verbatim into `server/api/errors.ts`)

The full table lives in LAYERS.md §TaggedErrors Catalog — transcribe all rows: `TaskNotFound→404 TASK_NOT_FOUND`, `ProjectNotFound→404`, `ColumnNotFound→404`, `SwimlaneNotFound→404`, `WikiPageNotFound→404 PAGE_NOT_FOUND`, `WipLimitExceeded→409 WIP_LIMIT`, `SlugTaken→409 SLUG_TAKEN`, `HasChildren→409 HAS_CHILDREN`, `NeighborNotInColumn→422 NEIGHBOR_NOT_IN_COLUMN`, `GithubIssueAlreadyLinked→409 ALREADY_LINKED`, `RequiredFieldMissing→422 REQUIRED_FIELD`, `ConstraintViolation→500 CONSTRAINT`, `DbError→500 DATABASE_ERROR`, `GithubApiError→502 GITHUB_API_ERROR`, `GithubWebhookError→400 GITHUB_WEBHOOK_ERROR`, `InvalidKey→401 INVALID_API_KEY`, `MissingAuth→401 MISSING_AUTH`.

# Appendix B — Known adaptation points (check at implementation time, note deviations)

1. TanStack Start Vite plugin wiring + SSR build output (`dist/server/server.js` import in `server/entry.ts`) — version-sensitive.
2. bun:sqlite API surface (`prepare/run/get/all`, WAL pragma) — verify against installed Bun version.
3. `effect` version: if `@effect/schema` is merged, use `Schema` from `effect`.
4. Departure Mono availability on Google Fonts — fallback: JetBrains Mono for micro labels (DESIGN_SYSTEM.md §Typography lists the fallback).
5. `fractional-indexing` export names (`generateKeyBetween`) — confirmed stable, but check on install.

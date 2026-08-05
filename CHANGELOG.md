# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

User-facing notes per release: `docs/RELEASE_NOTES.md`.

## [Unreleased]

### Added

- **Rate limiting** — in-process per-IP limiter on `/api/*` + `/mcp` (webhook-exempt; 600 req/10 min, 429 `RATE_LIMITED` + `Retry-After`) — `server/api/rate-limit.ts` + tests
- **Access JWT verification** — opt-in via `LXK_ACCESS_AUD` (`server/api/access-auth.ts`, SSRF-hardened JWKS fetch); without it, identity headers are trusted as before with a boot warning
- **`lexa-cli deploy`** — Docker + cloudflared tunnel + Access provisioning (dev/staging/prod, `--bare`) replacing the legacy setup.sh
- **Admin-only enforcement on settings/admin/Forge CRUD** — caller identity from the API key, non-admins 403; last-admin demote/remove guarded (`LAST_ADMIN_DEMOTE`)

### Changed

- **API gatekeeping moved into HttpApi middleware** — rate limit, content-length pre-check, API-key auth (daemon-token/setup/health exempt), and security headers now live in `server/api/middleware.ts` as API-level middleware; `server/entry.ts` shrinks to boot + webhook + `/mcp` + static + stream-cap glue. Same envelopes/statuses/log lines; `x-lexa-remote-ip` socket-IP stamping (spoof-safe) feeds the limiter
- **Request body cap** — `LXK_MAX_BODY_MB` (default 16 MB) enforced early in `server/entry.ts` (413 `BODY_TOO_LARGE`)
- **DELETE endpoints return 204** — 7 routes aligned to the API.md contract (client already handled 204)
- **MCP error paths hardened (oracle audit)** — authz denials return a FORBIDDEN tool envelope instead of a bare HTTP 500; inline tool errors (`INVALID_OPTION` + `available*`, `TASK_NOT_FOUND`) no longer degrade to `INTERNAL`; MCP move now triggers best-effort GitHub state sync like the REST move; missing-arg guards (`INVALID_ARGS`) in column tools; `unlink_github_issue` 404s properly; `WipLimitExceeded` carries `current` in details. New `server/mcp/server.test.ts`: 9 regression tests (authz matrix, error codes, JSON-RPC validation, 35 tools).
- **Rate limiter IP trust** — `cf-connecting-ip` accepted only from private socket peers (tunnel sidecar); direct-origin requests are keyed by socket IP (`isPrivateIp` helper + tests)
- **Docs** — SECURITY.md fully closed; `docs/RATE_LIMITING.md` added; API.md error table corrected to implemented statuses (502/422 `SOURCE_*`, 409 `CONSTRAINT`/`LAST_ADMIN_DEMOTE`, 413/429 early gates); stale plan docs removed
- **Denied-path logging (oracle audit)** — webhook HMAC rejections, 413/429 gates, and API 401/403 denials now emit structured warnings (ids/paths/reasons only, never keys or bodies); MCP tool/auth/rejection errors log via the Effect logger; uncaught MCP rejections logged before rethrow
- **entry.ts body-cap hardening (oracle audit)** — every `/api` body (incl. `/api/setup/*`) now stream-capped via `readBodyWithLimit` — chunked/CL-less requests can no longer bypass the `LXK_MAX_BODY_MB` cap (request is reconstructed for the handler); key-bearing SSR HTML + fallback page carry `Cache-Control: no-store` + `nosniff`
- **entry.ts tidy** — `/mcp` rate check merged into its branch (no more redundant surface wrapper); INTERNAL 500 no longer echoes `err.message`; `ssrFetch` failures logged + 500 instead of a bare Bun error; `PORT`/`LXK_MAX_BODY_MB` validated at boot (NaN falls back with a warning); generated admin key printed only on interactive boots (TTY gate — container logs never persist it); `..` rejected in static paths (defense in depth); fallback page copy points at `/mcp`; SSR module import typed (no `as any`)
- **Data-layer hardening (oracle audit)** — field-config `replace()` atomic across priority/type lists (single tx); project update/delete surface `SLUG_TAKEN` (409) instead of masking as 404; new `TASK_HAS_CHILDREN` (409, defensive) on task delete; subtask cascade moves share the parent's position-collision retry; raw SQL consolidated into repos (`countByColumn`, `findSubtasks`, `createSubtaskLink`, wiki prune, swimlane/column counts, last-admin demote); task list/board/count queries use a slim select (no TipTap blob — `description` returns empty doc; fetch task for content); `GROUP_CONCAT` assignee separator `,`→`||`; webhook `edited`/no-op paths record delivery; machine delete wrapped in one tx; typed nullable repo rows (no `null as` casts). `server/api/errors.test.ts` +1 (151 total)
## [0.1.0] - 2026-08-04

First release. Self-hosted PM tool for small game-dev teams: kanban, wiki,
AI writing assistant, MCP server for agents, and two-way GitHub issue sync.

### Added

- **Kanban board** — swimlanes, atomic WIP limits, required-field gates,
  drag-and-drop with stable fractional-index ordering, task archive/restore,
  per-project priority/type labels, task links (subtasks / blocked-by / related)
- **Tasks** — TipTap rich-text descriptions, assignees, GitHub issue
  link/unlink with live Synced/Diverged status
- **Wiki** — nested pages, FTS5 full-text search, revisions with restore,
  Markdown ↔ rich-text conversion
- **Forge (AI writing assistant)** — agents (rule bundles) + skills,
  pluggable runtimes (OpenCode / Hermes / Command Code), control panel
- **GitHub two-way sync** — GitHub App client, webhook route (HMAC-verified,
  echo-suppressed, delivery dedup), column ↔ issue-state mapping, multi-issue
  links, out-of-sync surfacing
- **MCP server** — 35 tools for agents (projects, tasks, wiki, GitHub links),
  API-key auth, project-scoped authorization
- **`lexa-cli`** — operator CLI (tasks, wiki, projects, Forge machine/daemon)
- **Auth** — Cloudflare Access for humans, `lxk_` API keys for machines,
  admin/member roles, API key management
- **Ops** — first-run setup wizard (CLI + web), single-process deployment
  (SSR + REST + MCP + webhooks) behind a cloudflared tunnel, SQLite WAL

### Fixed

- **bun:sqlite constraint classification** — `run()`/`batch()` now detect
  `UNIQUE constraint failed:` (bun never emits the literal `SQLITE_CONSTRAINT`),
  restoring 409 `SLUG_TAKEN` / `HAS_CHILDREN` / `OPTION_IN_USE` and the
  fractional-index `isPositionConflict` retry (previously all surfaced as 500)
- **GitHub App JWT signing** — PKCS#1 keys (GitHub's actual format) normalized
  to PKCS#8 before Web Crypto `importKey`
- **Webhook event matching** — `X-GitHub-Event: issues` + `payload.action`
  composition (compound `issues.closed` header values never arrive from GitHub)
- **React Doctor sweep (34 → 38/100)** — fixed all 14 app-code errors
  (ref reads in render, unguarded `document`/`window` in render, impure state
  updater, effect with fresh deps), missing `type="button"` on 10 buttons,
  overlay click-catchers converted from `div[role=button]` to native buttons,
  `toSorted`/`flatMap`/Set-lookup perf fixes, `Intl.DateTimeFormat` module
  instances instead of per-render `toLocale*`, dead exports removed,
  `fetch` response status check in SSRF guard, versioned Forge dismissal key.
- **React Doctor sweep II (56 → 81/100)** — modal state-sync effects removed
  (forms conditionally mounted, selection derived during render, guarded
  render updates), 33 custom `role="dialog"`/`role="alertdialog"` containers
  converted to native `<dialog open>` with accessible names (slideovers,
  confirmations, forms; form submit preserved), 56 static-element/click-key
  interaction fixes (overlay click-catchers as buttons, menu roles, card
  keyboard support), 61 label/placeholder/control-label fixes, webhook
  signature verification made explicit in the route, setup wizard no longer
  persists the API key to localStorage, `URL.parse` guard, context value
  memoized, `useSyncExternalStore` for client-only toast rendering,
  `useEffectEvent` for document listeners, `Intl` formatters with explicit
  locale/timezone, async submit reentry guards, stable list keys.
  Remaining warnings (giant/multi-comp splits, dialog polish) are tracked as
  follow-up.
- **Menu component click bug** — the outside-click mousedown listener only
  checked the trigger container, but the popover renders in a PORTAL: any
  click inside the popover counted as "outside", unmounting the menu on
  mousedown and swallowing the item's `click` — menu items (column/swimlane
  settings, card menus) never fired. The popover is now treated as inside.
- **React Doctor sweep III (89–90/100)** — structural refactors: `__root.tsx`
  split into `app/components/layout/` (NavLink, ProjectSwitcher, UserProfile,
  AppShell), New Project modal → `CreateProjectModal`, wiki edit split →
  `WikiEditSplit` + `WikiEditor`, context menu → `WikiPageContextMenu`,
  search box → `WikiSearchBox`, Admins section → `AdminsSection`, Forge
  summary strip → `SummaryStrip`, ForgePopover prompt/runtime →
  `PromptFields`, `textEditorExtensions` → `app/lib/tiptap.ts`,
  `emptyFilters`/`isFilterActive` → `app/lib/filters.ts`, wiki helpers →
  `app/lib/wiki.ts`. 8 warnings remain (giant-component splits, useReducer,
  jsx-max-depth) — tracked as follow-up.
- **React Doctor sweep IV (91 → 100/100)** — split the TaskDetail giant
  (870 → 271 lines) into TaskPropertyBar, GitHubSection, TaskFooter,
  TaskDescriptionSection, DeleteTaskDialog, TaskNotFoundDialog,
  SlideoverHeader, TaskTitleInput, MissingFieldsWarning, `useTaskDetailActions`
  hook, `icons.tsx`, `AssigneeChips`, `SelectDropdown`, `DescriptionEditor`;
  ForgeControlPanel → FilterBar + HistoryTable + SummaryStrip; ForgePopover →
  TaskStatusPanel + PromptFields; KanbanBoard → BoardLane + BoardToolbar +
  BoardEmptyState + SortableTaskCard; KanbanSettingsModal → section/table
  components (Columns/Option/SwimlanesSettingsSection, ConfirmDeleteDialog,
  DescriptionModal); WikiPageViewer edit state → `useReducer`
  (`editReducer`/`initEditState`). **Fixed a reducer bug the refactor
  introduced**: the save `finally` dispatched `stopEditing`, so the ~800ms
  autosave after entering edit mode kicked the user back to read mode — now
  a `done` action that only clears `isSaving`. Wiki `app/router.tsx`
  "unused-file" is a documented false positive (build entry consumed by the
  vite `tanstackStart` plugin by convention — verified the build fails without
  it), excluded in `doctor.config.ts` with evidence. 0 issues remain.
- **Skill hygiene** — project-bound `.agents/` and `.repos/` gitlink removed
  (skills are global-only); `.repos/effect` pinned to `effect@3.22.1` matching
  the installed version (was v4 beta — source research returned wrong APIs)

### Notes

- Migration history squashed into a single clean `0001_init.sql` (unreleased
  squash) — fresh installs only; pre-release DBs continue to boot unmodified
- Full verification ledger: `docs/RELEASE.md`

## Build log — 2026-07-31 → 2026-08-05

Internal implementation history, migrated verbatim from docs/IMPLEMENTATION.md (deleted 2026-08-06).

## Completed phases (0–7)

Phases 0–7 are implemented and merged — v0.1.0 shipped 2026-08-04 (tag `v0.1.0`, see RELEASE.md): Bun scaffold, SQLite schema + repos/services, Kanban CRUD (atomic move, WIP, required_fields, `/board`), frontend core (dashboard, board, task detail), wiki (FTS search, markdown module, TipTap editor), the MCP server (35 tools, API-key auth), and GitHub two-way sync (Phase 6). Dated follow-up log below.

**Follow-up (2026-08-05):** two fixes from live-run review — (1) **stale skill dirs**: opencode auto-discovers every bundle under `.agents/skills/`, so pre-rename orphans (`continue/`, `rewrite/`) were read into runs. The claim response now carries the full current `skillIds` set (additive field, API.md) and the daemon prunes any dir not in it at claim time (race-free — concurrent runtimes share the same set). (2) **Requirements skill tightened** to checklist-only output ("Write only the task's requirements… No design proposals or background") — the model was replacing whole documents with 10k-char design specs. Migration `0005_forge_requirements_tighten.sql` (idempotent; 0001/0004 carry the same text).

**Forge agent + skills reposition (2026-08-05):** the builtin **Lexa** agent stops being a game-dev writing assistant and becomes a generic **project-management assistant** (any project type): writes and sharpens task descriptions, requirements, and wiki pages; may **read the project workspace** for grounding, still output-text-only (no file writes, no commands, no external systems). The 5 original writing builtins are repurposed into a PRD-standard PM set with **ids renamed to match**: `continue`→`requirements`, `rewrite`→`deliverables`, `summarize`→`review`, `expand`→`definition-of-done`, `grammar`→`status`; new builtin **`polish`** (writing refinement) added — 6 builtins total, all bound to Lexa. Migration `0004_forge_pm_skills.sql` renames ids children-first (forge_agent_skills → forge_tasks → forge_skills, FK-safe), updates agent + skill content, `INSERT OR IGNORE` polish + binding; `0001_init.sql` seeds the same state for fresh installs (convergent — 0004 no-ops there). `forge.service.ts` defaults updated (Reset-to-default path). Delivery mechanics unchanged (`.agents/skills/<id>/SKILL.md`, claim fields `skill*`, API routes) — the term "skills" is kept. UI copy updated ("AI writing assistant" → "AI project assistant"); wireframes rebuilt. Docs: wireframes (settings-agents-skills.html, forge-popover.html, forge-control-panel.html, forge-review.html).

**Setup/install (2026-07-31):** added the fullstack install wizard — `bun run setup` (CLI: admin email, API key, migrations, seed toggle) and the first-run web wizard at `/setup` (admin email, API key generation, sample-data toggle; `/api/setup/*` is API-key exempt). Admin emails persist in the `settings` table (env OR settings in `server/api/auth.ts`). Boot-time seeding is opt-in via `LXK_SEED_DEV=1`; the wizard owns sample data. See AGENTS.md "Running the dev stack".

**Task archive (2026-08-01):** soft-archive via `tasks.archived_at` (migration `0009_task_archive.sql`). `POST /archive` + `/restore` endpoints (idempotent), `?includeArchived` on `/board`, MCP `archive_task`/`restore_task` tools + `list_tasks includeArchived`. Archived tasks keep column/position, are excluded from WIP/count/board queries, and render dimmed + non-draggable with a "Show archived" toggle (card kebab + TaskDetail footer actions). Delete is untouched. Docs: API.md, MCP.md, LAYERS.md, SCHEMA.md.

**Task field options (2026-08-01):** per-project customizable priority/type. `priority_options`/`type_options` tables (migration `0010_task_field_options.sql`, backfills legacy enums 1:1); `tasks.priority`/`type` are now option IDs. `GET/PUT /api/projects/:slug/field-config` (PUT is a full replace with `OPTION_IN_USE` 409 on deleting a used option, `INVALID_OPTION` 422 on bad ids/dupes/empty); `/board` carries `fieldConfig`. Board Settings modal gains Priorities + Types sections (add/edit/delete/drag-reorder; first option = create default). MCP speaks labels: `get_project` lists priorities/types, `create_task`/`update_task`/`list_tasks` accept labels case-insensitively and return labels + ids in TaskSummary. Dashboard "urgent" now = the project's first priority option. Docs: SCHEMA.md, API.md, MCP.md, LAYERS.md, DESIGN_SYSTEM.md, wireframes.

**Forge — runtime agent writing assistant (2026-08-01):** multica-style daemon runtime. Migration `0011_forge_runtimes.sql`: `runtimes`, `forge_tasks` (queued→running→completed/failed), `document_sources` (persisted wiki/external sources). `/api/forge/*` — runtime register/heartbeat/claim, task create/get/complete/fail (daemon auth via `LXK_FORGE_DAEMON_TOKEN` x-forge-token or Bearer); `document_sources` CRUD per document. `scripts/forge/daemon.ts` (`bun run forge:daemon`) polls, spawns `opencode --print`/hermes per task in a temp workdir, reports result. Sources: wiki pages resolved server-side, external URLs fetched with SSRF guard (private/loopback/CGNAT blocked, `server/forge-ssrf.ts` + tests). Frontend: Forge popover in the shared editor toolbar (actions, sources, streaming result, Accept replaces selection/inserts at cursor), Sources section on TaskDetail + WikiPageViewer. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, wireframes (forge-popover.html). Out of scope v1: skills marketplace, autopilots, resumable sessions, daemon on prod docker, agents-on-the-board assignment UI.

**Forge machine setup (2026-08-03):** `lexa-cli machine listen` registers a machine and owns per-runtime daemon children. The web wizard sends only machine + agent CLI + a fresh key; provider/model, agent persona, logging, and extra args are configured after setup from Settings. The listener reports installed CLI agent/model catalogs with machine heartbeats. Offline runtime removal is blocked; online removal queues a machine-scoped despawn event before deleting the runtime row. Migrations `0023_runtime_setup_events.sql` through `0026_runtime_agents_catalog.sql` add the machine registry, event contract, runtime link, and agent catalog.

**Forge agents + skills (2026-08-03):** the fixed action enum becomes global rule bundles. Migration `0027_forge_agents_skills.sql`: `forge_agents` (builtin **Lexa**), `forge_skills` (builtins Continue/Rewrite/Summarize/Expand/Fix grammar, seeded from the old ACTION_PROMPTS), `forge_agent_skills` M2M bindings (Lexa ↔ all 5), and `forge_tasks.action` → `agent_id` + `skill_id` + `extra_prompt` (table rebuild, backfill by action, agent → 'lexa'). Delivery is **files-only, claim-carried**: the claim response carries `agentMarkdown`/`skillMarkdown`; the daemon writes them into the run dir as `AGENTS.md` + `.agents/<skill>/SKILL.md` (CLI-native discovery — no host store, no sync layer, edits apply to the next run). The prompt carries task context + output contract + the per-run `extra_prompt` + a pointer line only. Settings gains Agents + Skills sections (editor modal: name/description/mono instructions/file preview, builtin Reset / custom Delete, agent attached-skills checkboxes); the Forge popover picks Agent → dependent Skill (defaults Lexa/Continue) + additional prompt; control panel filter becomes All skills. Runtime rows relabel "Agent" → "CLI" and "Agent persona" → "Persona" (labels only — kills the name collision with the new agents). **Machine state root:** everything the host stores moves under `~/.lexa/` (`LEXA_DIR`): `config.json`, `machine-id`, `env`, `runtimes/<id>/env`, `runs/<taskId>/` (ephemeral workdirs — explicit cleanup after every run). The listener + `lexa-cli login` migrate the legacy `~/.config/lexa-cli` / `~/.config/lexa-forge` dirs into it — migrate-and-delete, no fallback. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, wireframes (settings-agents-skills.html, forge-popover.html). Out of scope: artifacts/retention, memory files, SKILL.md assets, per-agent access, agent→runtime binding, per-project agents/skills, sync-health notifications (drift is impossible by construction).

**Task links — subtasks / blocked-by / related (2026-08-01):** one directed `task_links` table (migration `0012_task_links.sql`, relation `subtask_of|blocked_by|related_to`). Deliberately reverses the v1 "cut subtasks" YAGNI — semantics now defined (REVIEW.md noted "undefined semantics, UX cost"; this defines them). Subtasks: children inherit the parent's column, `POST /tasks` gains `parentId`, moving a parent cascades to children, cycle guard (`TASK_LINK_CYCLE`). Blocked-by: informational amber dot + tooltip (no move guard). Related-to: symmetric display. `GET/POST/DELETE /api/projects/:slug/tasks/:id/links` + `GET /tasks/search?q&exclude` (@-autocomplete: title LIKE, cap 10, excludes self). Board carries `links` for grouping. Frontend: parent cards show chevron + count with indented child cards (kanban-card-subtask), Links section with @-autocomplete + relation dropdown on TaskDetail. Docs: SCHEMA.md, API.md, LAYERS.md, DESIGN_SYSTEM.md, REVIEW.md, wireframes.

**Forge control panel (2026-08-03):** global `/forge` page listing every Forge task across projects, newest first — summary strip (per-status counts ride the history response; no separate aggregate endpoint), status-chip + project + action filters, keyset-paginated task table, and a 520px task-record slideover (meta grid, live activity log, Markdown result / error box). Backend: `GET /api/forge/tasks/history` (`ForgeTaskHistoryResponse` with `data + nextCursor + summary`; repo `listHistory` keyset on `(created_at, id)` DESC with `document_title` CASE subquery + INNER JOIN projects, `countByStatus` for the summary). Client: `listForgeTaskHistory` + `useForgeTaskHistory` (polls 1.5s while any page row is queued/running, 15s idle); `useCancelForgeTask` also patches cached history pages via `setQueriesData`. Navbar Forge pill gains a "Forge control panel" item. Wireframe-first: `wireframes/src/forge-control-panel.html` (registered in index.html + navbar partial). Docs: API.md, DESIGN_SYSTEM.md §5.9m, wireframes. Out of scope: per-filter summaries, live totals across pages, result rendering as HTML (Markdown shown raw, read-only).

**Forge log levels (2026-08-04):** write-time severity classification. New `shared/forge-log.ts` — pure `classifyLogLine(stream, message)` (error tier: error/fail/exception/fatal/denied/refused/panic/unable/couldn't/timeout; warn tier: retry/rate limit/backoff/warn/deprecat/slow/skip/fallback/limit; heuristics on stderr only — stdout is always info) + vitest tests. Migration `0003_forge_log_levels.sql` adds `forge_task_logs.stream` ("out"|"err") + `level` ("info"|"warn"|"error"), default out/info for legacy rows. The daemon classifies each line ONCE at write time (`logTask` meta, `tee()` passes stream + shared classifier; lifecycle lines stay info; `▸`/`[stderr]` transport markers kept in the message so Copy output is unchanged) — the UI renders the stored level (warn = amber `!`, error = danger `!`, info = neutral `●`), with a regex fallback only for legacy rows still carrying the `[stderr]` marker. **Daemon is now BUNDLED before install** (it imports shared/forge-log): the listener runs `bun build --target=bun` → `~/.local/share/lexa-forge/daemon.js` on every start, and `compile:cli` embeds the bundled daemon into `packed.ts` (spawn path `daemon.js`). Docs: SCHEMA.md, API.md, wireframes (forge-control-panel.html). Out of scope (tracked): structured JSON-level parsing from the agent, ANSI stripping, per-provider tuning beyond opencode.

**Forge machine hosting + deletion + key-revocation (2026-08-04):** migration `0002_forge_auth_state.sql` adds `machines.clis` and `runtimes.last_error`. Model correction: **runtime → machine** — a machine is a host (0..N runtimes, at most one per agent CLI); runtimes are bound to it via `machine_id` at setup. Lifecycle: `lexa-cli login` binds the machine (`POST /api/forge/machines/register`, upsert preserving `last_seen` = NULL → "bound, not listening"); `machine listen`/`machine start` (systemd) heartbeats every 3s → Listening; 2 min stale → Offline. New machine ids are `hostname-<unique>` (shared `getOrCreateMachineId()`); legacy UUID ids keep working. The listener probes installed CLIs at start (`opencode --version`, `cmd --version`; hermes skipped) and sends `clis` with every heartbeat. **Deletion never blocks:** `DELETE /api/forge/runtimes/:id` drops `requireOnline`/`MACHINE_OFFLINE` (error removed) — it queues the provider-scoped machine `remove` event (delivered on the listener's next heartbeat) and deletes the whole `(machine_id, provider)` pair (event semantics = one runtime per machine+agent CLI). `DELETE /api/forge/machines/:id` queues remove events for each runtime, cascade-deletes runtime rows + pending events (FK CASCADE), then the machine row — a still-listening machine reappears on its next heartbeat (documented in the confirm dialog: stop the listener first for permanent removal). **Key revocation:** any daemon API 401 → `process.exit(3)` (auth-failure code); the listener does NOT respawn exit-3 daemons and relays `{runtimeId, error}` via the machine heartbeat (`daemonErrors`) → `runtimes.last_error`; Settings shows "API key revoked — re-run Setup runtime" (cleared on daemon register/heartbeat success). Recovery = re-run Setup runtime (fresh key via install event). **Stuck-task sweeper:** runs on the machine heartbeat (3s cadence while any machine listens): `running` forge tasks with `started_at < now-10min` AND an offline runtime (last_seen < 2min) → re-queued (`runtime_id`/`started_at` cleared); **stale-run auto-removal**: `running` tasks started longer than `FORGE_STALE_RUN_MIN` (default 30m) whose runtime is offline or gone are hard-deleted (task + activity log) — the runner is dead and will never post a result, so the record is purged instead of re-queued forever; a live runtime is never touched (long runs are legitimate). MCP probe gated to cloud agents only (`NEEDS_MCP = hermes`); daemon HTTP gets 15s timeouts + 5s MCP timeouts + `FORGE_RUN_TIMEOUT_MS` (default 15m) max agent-run wall clock (fixed a pre-existing missing `readdirSync` import that crashed `killTree` on cancel/timeout). Settings gains a **Machines block** above the runtime table (id, Listening/Bound/Offline chip, runtime count, CLIs, last seen, delete confirm) and runtime remove is always enabled. CLI: `runtime list` shows IDs; new `runtime delete <id>` and `machine delete <id>`. Docs: SCHEMA.md, API.md, CHANGELOG.md (this log), wireframes (settings.html, settings-runtime-setup.html). Out of scope (tracked): task-unclaimed → machine event, artifact retention, multi-runtime-per-agent support.

**GitHub sync (2026-08-04):** two-way issue sync, Phase 6. `server/github/crypto.ts` — pure Web Crypto helpers (RS256 app JWT `iat-60/exp+540/iss`, HMAC-SHA-256 webhook signature verify, constant-time) + tests. `server/github/client.ts` — `GitHubConfig` (env `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_PRIVATE_KEY_FILE`/`GITHUB_WEBHOOK_SECRET`; file path read at boot, inline wins), module-scope installation-token cache (50-min refresh) with per-repo installation resolution, hand-rolled fetch for `createIssue`/`updateIssueState`/`getIssue`. `WebhookEventRepo` (`isSeen`/`recordDelivery`/`prune`) + `GitHubService` (`syncStateFromLexa` per linked issue, `createLinkedIssue` with per-repo `ALREADY_LINKED` guard, `handleWebhook`: dedup pre-check → event filter → `findByGithubIssue` → edited=title sync → per-issue echo suppression via `task_github_issues.synced_state` → column by `github_state` mapping → `TaskService.moveFromWebhook` (now with archived-guard) → `recordDelivery` only after success). Webhook route `/api/webhooks/github` lives OUTSIDE the HttpApi app (HttpApi consumes the body before handlers; HMAC needs raw bytes) — API-key exempt, verifies signature before parse (401), acks 200 immediately, processes fire-and-forget on a shared Effect runtime (Bun has no `waitUntil`); `webhook_events` pruned at boot (>7d). REST: `POST /api/projects/:slug/tasks/:id/github-link` (create + link; 409 `ALREADY_LINKED`, 502 `GITHUB_API_ERROR`) and `DELETE /api/projects/:slug/tasks/:id/github-link/:issueId` (multi-issue unlink, no issue close); the move handler orchestrates best-effort `syncStateFromLexa` (`catchTag(GithubApiError → logWarning)`, never fails the move). MCP stubs replaced (`link_github_issue` → `{issueNumber, url}`, `unlink_github_issue` → `{unlinked: true}`; project-access check added). Frontend: real link/unlink in TaskDetail (replaces the setTimeout mock), `api.ts` functions, board cache via `setQueryData`. Env vars added to `.env.example`/`.env.prod.example`/`.env.staging.example`, docker-compose (PEM volume-mounted read-only in prod compose; `.dockerignore` excludes it), `lexa-cli deploy` preserves the GitHub block when rewriting env files. Deviations declared: GitHubService built against the multi-issue junction table (`task_github_issues`), not the single-issue inline columns in the LAYERS.md snippet (SCHEMA.md authoritative); DELETE link endpoint takes `:issueId` path param (multi-issue, API.md updated); GitHub webhook protocol is `X-GitHub-Event: issues` + `payload.action` (closed/reopened/edited), not compound header values — the handler composes the `issues.<action>` form (LAYERS.md snippet adaptation, API.md updated); GitHub App keys are PKCS#1 ("BEGIN RSA PRIVATE KEY") — normalized to PKCS#8 via `node:crypto.createPrivateKey` before Web Crypto importKey (Web Crypto only accepts PKCS#8).

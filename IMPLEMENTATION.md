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

- Single Cloudflare Worker serves SSR frontend + REST API + MCP + webhooks.
- TanStack Start API-route files are **thin pass-throughs** into one Effect `@effect/platform/HttpApi` app (isolates us from TanStack's API-route API churn).
- Repos use the **raw D1 binding API** (`prepare/bind/all/first/run/batch`) wrapped in Effect — no ORM, no `@effect/sql-d1` (deterministic, version-proof).
- MCP is **stateless Streamable HTTP**: POST-only JSON-RPC 2.0 for exactly these methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- GitHub calls are hand-rolled `fetch` (3 endpoints only) — no Octokit dependency.
- Auth: Cloudflare Access for humans (configured manually by the user in the CF dashboard), `lxk_` Bearer keys for machines. There is NO login page, NO session code.
- Markdown↔TipTap conversion is a hand-rolled pure module (`shared/markdown.ts`) over a defined subset — no DOM-dependent libraries.

---

# Phase 0 — Scaffold

Goal: empty deployable shell. **Do not build features here.**

### 0.1 Init

```bash
cd ~/projects/lexa
npm init -y
npm install effect @effect/platform @effect/schema \
  react react-dom \
  @tanstack/react-router @tanstack/react-start @tanstack/react-query \
  @tiptap/react @tiptap/pm @tiptap/starter-kit \
  @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities \
  fractional-indexing marked lucide-react clsx tailwind-merge
npm install -D typescript wrangler @cloudflare/vite-plugin vite \
  tailwindcss @tailwindcss/vite vitest @types/react @types/react-dom
```

(If `@effect/schema` is deprecated/merged in installed `effect` version, drop it and use `Schema` from the `effect` package instead. Note the deviation.)

### 0.2 Files

**`wrangler.jsonc`**
```jsonc
{
  "name": "lexa",
  "main": "dist/server/index.js",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,                      // HARD RULE — Access is the only edge
  "d1_databases": [
    { "binding": "DB", "database_name": "lexa-db", "database_id": "<fill-after-0.3>", "migrations_dir": "migrations" }
  ],
  "triggers": { "crons": ["17 3 * * *"] },   // daily webhook_events prune
  "observability": { "enabled": true }
}
```

**`tsconfig.json`** — strict, `"moduleResolution": "bundler"`, `"types": ["@cloudflare/workers-types"]`, include `app/`, `server/`, `shared/`.

**`vite.config.ts`** — TanStack Start plugin + `@cloudflare/vite-plugin` + `@tailwindcss/vite`. Follow the TanStack Start Cloudflare quickstart for the installed version's exact plugin wiring.

**`worker-configuration.d.ts`** — generate with `wrangler types`; ensure `interface Env { DB: D1Database; GITHUB_APP_ID: string; GITHUB_PRIVATE_KEY: string; GITHUB_WEBHOOK_SECRET: string }`.

### 0.3 Create the database

```bash
wrangler d1 create lexa-db          # paste returned database_id into wrangler.jsonc
```

### 0.4 Directory tree (create empty)

```
app/            # TanStack Start (frontend + route pass-throughs)
  routes/
  components/
  styles/
server/         # Effect backend (all business logic)
  db/ repos/ services/ api/ mcp/ github/
shared/         # types + pure functions used by both sides
migrations/
```

### 0.5 Acceptance

`wrangler dev` boots; `tsc --noEmit` passes.

---

# Phase 1 — Foundation + integration spike

Goal: prove SSR + REST + D1 work in one deploy BEFORE building on them. Deliver schema, repos pattern, two services, health endpoint.

### 1.1 Migration

`migrations/0001_init.sql` = **verbatim copy of `SCHEMA.md` §Full Schema** (all tables, triggers, indexes).

```bash
wrangler d1 migrations apply lexa-db --local
wrangler d1 migrations apply lexa-db --remote
```

### 1.2 `server/db/d1.ts`

```typescript
import { Context, Effect, Layer, Data } from "effect";

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class RowNotFound extends Data.TaggedError("RowNotFound")<{ table: string }> {}
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{
  message: string;
  isPositionConflict: boolean;   // true when message contains "tasks.column_id, tasks.position"
}> {}

export class D1 extends Context.Tag("Lexa/D1")<D1, D1Database>() {}
export const d1Live = (env: Env) => Layer.succeed(D1, env.DB);
```

Helpers used by all repos (implement once here):
- `queryAll<T>(stmt, ...params): Effect<T[], DbError>` — `prepare().bind().all()`, map rows→T
- `queryFirst<T>(stmt, ...params): Effect<T, RowNotFound | DbError>` — `.first()`, null → RowNotFound
- `run(stmt, ...params): Effect<number, ConstraintViolation | DbError>` — `.run()`, returns `meta.changes`; catch D1 errors, map `SQLITE_CONSTRAINT` → `ConstraintViolation` (set `isPositionConflict` by message inspection), else `DbError`
- `batch(stmts): Effect<void, ConstraintViolation | DbError>` — `db.batch([...])`

### 1.3 Repo pattern (`server/repos/`)

One file per repo, all following this exact shape (example: `project.repo.ts`):

```typescript
export class ProjectRepo extends Effect.Service<ProjectRepo>()("Lexa/ProjectRepo", {
  effect: Effect.gen(function* () {
    const db = yield* D1;
    return {
      create: (input: { id: string; name: string; slug: string; description: string; githubRepo: string | null }) =>
        run(db, `INSERT INTO projects (id,name,slug,description,github_repo) VALUES (?,?,?,?,?)`,
          input.id, input.name, input.slug, input.description, input.githubRepo),
      findBySlug: (slug: string) => queryFirst<ProjectRow>(db, `SELECT * FROM projects WHERE slug = ?`, slug),
      // ...list, findById, update, delete
    };
  }),
}) {}
```

Row mappers (`rowToProject`) live beside each repo — snake_case row → camelCase domain. Domain types come from `shared/types.ts`, which is **a verbatim TypeScript transcription of API.md §Entity Schemas**.

Repos for Phase 1: `ProjectRepo`, `TaskRepo` (full method list from LAYERS.md §Repositories: create, findById, findByProject (filters+pagination), move (conditional UPDATE — SQL copied from SCHEMA.md §Atomic WIP-limit enforcement, plus a `bypassWip` variant without the count clause), update, delete, findLastInColumn(projectId, columnId), findByGithubIssue, setGithubLink, setGithubSyncedState).

### 1.4 Services (`server/services/`)

`ProjectService`, `TaskService` — implement `create/findByProject/getById/update/delete` exactly per LAYERS.md §TaskService including: project/column/swimlane existence + same-project validation, `validateRequiredFields` with `isEmptyDoc` (TipTap emptiness = no text-bearing nodes anywhere in the doc), position generation with re-read-and-retry-once on `isPositionConflict` (LAYERS.md create snippet). `move` comes in Phase 2.

`shared/positions.ts`:
```typescript
import { generateKeyBetween } from "fractional-indexing";
export const keyAfter = (last: string | null) => generateKeyBetween(last ?? null, null);
export const keyBetween = (a: string | null, b: string | null) => generateKeyBetween(a, b);
```

### 1.5 HTTP shell (`server/api/`)

- `server/api/http.ts` — one `HttpApi` app; Phase 1 registers only `GET /api/health` → `{ ok: true }` and the projects group (list/create/getBySlug). Error mapping via `.addError(X, { status })` exactly per LAYERS.md §TaggedErrors Catalog. Global error envelope `{ error: { code, message, details } }` per API.md.
- Auth middleware skeleton (`server/api/auth.ts`): two strategies — `Authorization: Bearer lxk_*` → Phase 1 stub returns 501 (real impl in Phase 5); CF Access JWT → Phase 1 stub passes through (real verify in Phase 7). Structure it so later phases fill the stub, not rewrite it.

### 1.6 TanStack Start pass-throughs

- `app/routes/api/$.ts` — splat route: convert the incoming `Request` to the HttpApi handler (`HttpApiBuilder.toWebHandler` or the platform's fetch adapter), inject `d1Live(env)`, return the web `Response`. Export `GET POST PATCH DELETE` handlers that all call this one function.
- `app/routes/__root.tsx` — bare shell importing `app/styles/phosphor.css` (empty file for now) + Google Fonts links (Space Grotesk, IBM Plex Sans, JetBrains Mono, Departure Mono).
- `app/routes/index.tsx` — renders `<h1>Lexa</h1>`.

### 1.7 Spike acceptance (paste outputs)

```bash
curl localhost:8787/api/health                          # {"ok":true}
curl -X POST localhost:8787/api/projects -d '{"name":"Emberfall"}'   # 201 with slug "emberfall"
curl localhost:8787/api/projects                        # contains Emberfall
curl localhost:8787/                                    # SSR HTML containing "Lexa"
wrangler d1 execute lexa-db --local --command "SELECT slug FROM projects"   # row present
```

---

# Phase 2 — Kanban CRUD

Goal: every task/column/swimlane endpoint works, with atomic moves, WIP, required_fields, pagination, `/board`.

### 2.1 Repos

`ColumnRepo` (CRUD + `getPolicies`→N/A — policies are inline now; methods: create, findById, findByProject, update, delete, maxPosition), `SwimlaneRepo` (same shape). Column delete maps `SQLITE_CONSTRAINT` (RESTRICT with existing tasks) → `HasChildren` 409 at the service layer (check count first, return clean error — do not rely on the FK error).

### 2.2 Services

`ColumnService`, `SwimlaneService` — plain CRUD + project validation.
`TaskService.move` — implement EXACTLY the LAYERS.md §TaskService move snippet: no-op early return; `validateRequiredFields` unless `bypassGuards`; `computePosition` (neighbors validated against target column → `NeighborNotInColumn`; no neighbors → append via `findLastInColumn`); `doMove` with retry-once on `isPositionConflict`; WIP via the conditional UPDATE (SQL from SCHEMA.md — includes the within-column short-circuit `column_id = ?2 OR ...`); `rowsChanged = 0` after existence check → `WipLimitExceeded`.
`TaskService.moveFromWebhook` — repo-level `batch()` of bypass-guard move + `setGithubSyncedState`.

### 2.3 Routes (`server/api/`)

Register per API.md: columns, swimlanes, tasks (all 7 endpoints incl. `/move` with the documented swimlane semantics and `/board`), error statuses from the catalog. Pagination helper (`shared/pagination.ts`): parse `limit` (clamp 1..200, default 50), cursor = base64 of `"<columnId>:<position>:<taskId>"`; `nextCursor` from the last row when `rows.length === limit`.

### 2.4 Acceptance (paste outputs)

```bash
# seed
P=$(curl -sX POST .../api/projects -d '{"name":"Emberfall"}' | jq -r .slug)
curl -X POST .../api/projects/$P/columns -d '{"name":"Backlog"}'
curl -X POST .../api/projects/$P/columns -d '{"name":"In Progress","wipLimit":1,"requiredFields":["description"]}'
# required_fields enforced on create
curl -X POST .../api/projects/$P/tasks -d '{"columnId":"'$C2'","title":"x"}'        # 422 REQUIRED_FIELD
# WIP enforced on move (2nd move into limit-1 column)
# → 409 WIP_LIMIT with details {column,limit,current}
# within-column reorder at limit succeeds (no WIP error)
# /board returns all columns + tasks in one response
# pagination: create 3 tasks, GET ?limit=2 → nextCursor present; follow it → 3rd task
```

---

# Phase 3 — Frontend core

Goal: usable dashboard + kanban + task detail, PHOSPHOR-styled, matching the wireframes.

### 3.1 Design tokens

`app/styles/phosphor.css` — transcribe every CSS custom property from DESIGN_SYSTEM.md §Color System (dark + light via `[data-theme]`), typography classes, and the Tailwind theme mapping from §8. Open `wireframes/wireframes.css` — it already implements these tokens; port it into the Tailwind setup rather than starting from scratch. Match wireframe structure class-for-class where practical.

### 3.2 Data layer

`app/lib/api.ts` — typed fetch client for API.md (one function per endpoint, Zod-free: types from `shared/types.ts`).
`app/lib/queries.ts` — TanStack Query hooks. **Board rule (from API.md): mutations return entities; every mutation's `onSuccess` calls `queryClient.setQueryData` — never `invalidateQueries` on the mutation path.** Keys: `["board", slug]`, `["projects"]`, `["wiki", slug]`, `["wikiPage", slug, pageSlug]`.

### 3.3 Routes/components

Build to match `wireframes/dashboard.html`, `kanban.html`, `task-detail.html` exactly (structure, density, badges, annotations become real tooltips/props):
- `app/routes/index.tsx` — dashboard grid of ProjectCards.
- `app/routes/$slug/index.tsx` — board: fetch `/board` via loader; render swimlanes × columns × cards; `TaskDetail` slideover via route `/:$slug/tasks/$taskId` (parallel-route pattern or query-param-driven overlay — pick one, note it).
- Components per ARCHITECTURE.md §Key Components: `KanbanBoard, SwimlaneHeader, Column, ColumnHeader(WipBadge), TaskCard, TaskDetail(PropertyBar, TipTapEditor read-mode for now), GitHubLink(outOfSync badge from task.github.outOfSync)`.

### 3.4 Drag and drop (`app/components/kanban/dnd.tsx`)

`@dnd-kit/core` `DndContext` + per-column `SortableContext` (cards) + droppable column bodies. `onDragEnd` algorithm:

```
over = droppable under pointer (column body OR another card)
targetColumnId = column containing `over`
if over is a card:
    items = that column's cards sorted by position
    idx = index of over card
    if dragging from above/earlier: beforeTaskId = over.id, afterTaskId = items[idx+1]?.id
    else: afterTaskId = over.id, beforeTaskId = items[idx-1]?.id
else (dropped on empty column body):
    beforeTaskId = afterTaskId = undefined        // append
POST /tasks/:id/move { columnId, swimlaneId: <current lane>, beforeTaskId, afterTaskId }
onSuccess → setQueryData(["board", slug]) with the returned task
onError WIP_LIMIT → revert optimistic state + flash the column's WipBadge (exceeded state, 1.5s)
```

Apply an optimistic update BEFORE the POST (move card in cache immediately); roll back on error.

### 3.5 Acceptance

Manual: create project/columns via curl, open `/$slug` in browser — create/move/reorder cards, drag between swimlanes, hit WIP limit and see the flash, open task detail, edit title inline. `tsc --noEmit` clean.

---

# Phase 4 — Wiki

### 4.1 Backend

`WikiRepo` (CRUD + `findChildren(parentId)` + `search(projectId, query)` via `wiki_fts` — `SELECT wiki_pages.*, snippet(wiki_fts, 1, '**', '**', '…', 32) FROM wiki_fts JOIN wiki_pages ON wiki_pages.rowid = wiki_fts.rowid WHERE wiki_fts MATCH ? AND project_id = ? LIMIT ?`), `WikiService` (slug auto-generation from title with `SlugTaken` on collision; delete → count children first → `HasChildren`), routes per API.md including `/search`.
`content_text` maintenance: on every create/update, derive plain text by walking the TipTap doc (`shared/tiptap-text.ts` — concatenate all `text` nodes with newlines between blocks). Store in the same statement.

### 4.2 Markdown module (`shared/markdown.ts`)

Pure, DOM-free. Both directions. Supported mapping (the ONLY supported set):

| Markdown (via `marked` lexer tokens) | TipTap node |
|---|---|
| `#`/`##`/`###` | heading level 1/2/3 |
| paragraph | paragraph |
| `**bold**` `*italic*` `` `code` `` `[t](url)` | marks bold/italic/code/link |
| `-` / `1.` lists | bulletList/orderedList + listItem |
| `- [ ]` / `- [x]` | taskList + taskItem (checked) |
| ```` ``` ```` fenced | codeBlock (attrs.language) |
| `>` | blockquote |
| `---` | horizontalRule |
| tables, html, images | **degrade: wrap source text in codeBlock** (md→doc) / emit as fenced block (doc→md) |

- md→doc: `marked.lexer()` → recursive mapper. Unknown token types → codeBlock fallback. Never throws.
- doc→md: recursive walker emitting the same subset; unknown nodes → fenced code block containing their text content. Never throws.
- Tests (`shared/markdown.test.ts`, vitest): round-trip each mapped construct; checklist round-trip preserves checked state; a table input becomes a codeBlock.

### 4.3 Frontend

Match `wireframes/wiki.html`: `app/routes/$slug/wiki/index.tsx` (page tree — recursive, collapsible, active amber border), `app/routes/$slug/wiki/$page.tsx` (TipTap editor in edit mode: `@tiptap/react` `useEditor` + StarterKit + taskList/taskItem extensions; save → PATCH with editor JSON; debounce 800ms autosave + "Saved hh:mm" indicator in Departure Mono). New page button (root + per-node child).

### 4.4 Acceptance

curl: create page → GET returns content; search for a word in it → hit with snippet; nested create (parentId) → children endpoint lists it; delete parent with children → 409 HAS_CHILDREN. Browser: edit + autosave + reload persists; tree navigation works.

---

# Phase 5 — MCP server

### 5.1 Auth (fill the Phase 1 stub)

`server/services/auth.service.ts` per LAYERS.md: `validateApiKey` — prefix check `lxk_`, `crypto.subtle.digest("SHA-256", raw)` → hex → `ApiKeyRepo.findByHash`, `touchIfStale(1h)`. `ApiKeyRepo` + admin routes (`/api/settings/api-keys` per API.md; raw key = `lxk_` + base62 of 32 `crypto.getRandomValues` bytes, returned once). Middleware order on `/mcp` and `/api/*`: Bearer first, else Access (stub), else 401.

### 5.2 JSON-RPC dispatcher (`server/mcp/server.ts`)

Stateless. POST only (GET → 405). Exact protocol behavior:

- `initialize` → `{ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "lexa", version: "0.1.0" } }`
- `notifications/initialized` → 202, empty body
- `ping` → `{}`
- `tools/list` → `{ tools: [...] }` — one entry per tool from MCP.md §Tools: `name`, `description` (include the §Agent Usage Notes relevant to that tool), `inputSchema` (JSON Schema, from MCP.md)
- `tools/call` → dispatch by `params.name` with `params.arguments`; success → `{ content: [{ type: "text", text: JSON.stringify(result) }] }`; domain error → `{ content: [{ type: "text", text: JSON.stringify({ code, message, details }) }], isError: true }` (MCP.md §Error Format); unknown tool → JSON-RPC error `-32602`.
- Every response: `Content-Type: application/json`. No SSE, no sessions, no batching.

### 5.3 Tool implementations (`server/mcp/tools/`)

One file per tool, each mapping to existing services — NO new business logic. Name resolution layer (`server/mcp/resolve.ts`): project by slug; column/swimlane by case-insensitive name within the project; failures → error with `details.available*` listing valid names (exact format per MCP.md §Identifier Ergonomics). Markdown conversion via `shared/markdown.ts` on every description/content input AND output. `TaskSummary`/`TaskDetail` shaping exactly per MCP.md §Response Shapes (column/swimlane as names, no description in summaries).

### 5.4 Acceptance

Add to OpenCode config and verify a real client session:
```jsonc
// ~/.config/opencode/opencode.json (or project .opencode)
{ "mcp": { "lexa": { "type": "remote", "url": "https://<dev-host>/mcp", "headers": { "Authorization": "Bearer lxk_..." } } } }
```
Then: `list_projects` → `create_task` (by column name) → `list_tasks` → `move_task` (by column name) → `get_task` (Markdown description present) → `search_wiki`. Paste the JSON-RPC transcripts. Also: wrong column name → error contains `availableColumns`.

---

# Phase 6 — GitHub sync

### 6.1 Manual steps (USER does these — pause and hand off)

1. GitHub → Settings → Developer settings → New GitHub App: name `lexa-<instance>`, webhook URL `https://<host>/api/webhooks/github`, webhook secret (generate), permissions **Issues: Read & Write**, **Metadata: Read**, subscribe to **Issues** events only.
2. Generate private key (PEM). Install the app on the target repo(s); note the installation ID (`github.com/settings/installations`).
3. `wrangler secret put GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET`.

### 6.2 `server/github/client.ts` (per LAYERS.md §Infrastructure)

- App JWT: RS256 via Web Crypto (`importKey` pkcs8, `sign`), claims `{ iat: now-60, exp: now+540, iss: APP_ID }`.
- Installation token: `POST /app/installations/{id}/access_tokens` with the JWT → token (1h TTL). **Module-scope cache** `Map<installationId, { token, expiresAt }>` with 50-min refresh (NOT inside any Effect layer — see LAYERS.md note).
- Endpoints (raw fetch, installation token): `POST /repos/{repo}/issues`, `PATCH /repos/{repo}/issues/{n}` (state), `GET /repos/{repo}/issues/{n}`.
- `verifyWebhookSignature(rawBody: ArrayBuffer, header: string)`: HMAC-SHA-256 via Web Crypto over raw bytes, hex-compare `sha256=...`, constant-time.

### 6.3 `GitHubService` + webhook route

Implement LAYERS.md §GitHubService **line by line**: `syncStateFromLexa` (task.githubRepo, non-blocking caller pattern), `createLinkedIssue` (already-linked guard, store `repo`), `handleWebhook` — signature verify BEFORE parse (route-level, raw body), `isSeen` pre-check, event filter, `findByGithubIssue`, edited→title sync, echo suppression via `githubSyncedState`, column by `githubState` mapping, `moveFromWebhook`, `recordDelivery` AFTER success. Webhook route: 200 immediately, processing inside `waitUntil` (from `cloudflare:workers` — verify the export name in installed wrangler types; fallback: pass `ExecutionContext` through the TanStack route context). No auth middleware on this route (HMAC is the auth).

Link endpoints (`POST/DELETE /api/projects/:slug/tasks/:id/github-link`) per API.md. Orchestration in the move route handler: after successful `TaskService.move`, if `column.githubState && task.github` → `syncStateFromLexa` with `catchTag(GithubApiError → logWarning)`.

Cron handler (`scheduled` event in the worker entry): `WebhookEventRepo.prune(7)`.

### 6.4 Acceptance

Move a linked task to the Done-mapped column → GitHub issue closes within seconds; the resulting webhook does NOT re-trigger a move (echo suppressed — verify in logs). Close the issue on GitHub → task lands in the mapped column. Kill the Worker mid-process (or force a DbError) → GitHub retries → event eventually processed (delivery not pre-recorded). Bad-signature POST → 401.

---

# Phase 7 — Polish + ship

1. **Settings UI** (`/settings`, `/$slug/settings`) matching `wireframes/settings.html`: API key table/create/revoke (show rawKey once in a copy block), column manager (name/color/WIP/requiredFields/githubState), swimlane manager.
2. **Board polish**: swimlane collapse persistence (localStorage), WIP approaching/exceeded badge states, out-of-sync card dots, empty-column states, drag shake on invalid drop — all per DESIGN_SYSTEM.md §Component Specs and the wireframes.
3. **Access (USER, CF dashboard)**: Access application on the hostname, email allowlist; **bypass policies for `/mcp` and `/api/webhooks/*`**; confirm `workers.dev` route disabled; then implement `Cf-Access-Jwt-Assertion` verification in `server/api/auth.ts` (fetch CF public keys `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, verify RS256, cache keys 1h module-scope).
4. Wire the remaining error→status mappings to the full catalog; re-run every phase's acceptance checks; `tsc --noEmit`; `vitest run`; `wrangler deploy`.
5. **Final checklist** (paste results): all Phase acceptance blocks green; OpenCode MCP session completes the §5.4 script against production; one full GitHub round-trip on production.

---

# Appendix A — Error catalog (copy verbatim into `server/api/errors.ts`)

The full table lives in LAYERS.md §TaggedErrors Catalog — transcribe all rows: `TaskNotFound→404 TASK_NOT_FOUND`, `ProjectNotFound→404`, `ColumnNotFound→404`, `SwimlaneNotFound→404`, `WikiPageNotFound→404 PAGE_NOT_FOUND`, `WipLimitExceeded→409 WIP_LIMIT`, `SlugTaken→409 SLUG_TAKEN`, `HasChildren→409 HAS_CHILDREN`, `NeighborNotInColumn→422 NEIGHBOR_NOT_IN_COLUMN`, `GithubIssueAlreadyLinked→409 ALREADY_LINKED`, `RequiredFieldMissing→422 REQUIRED_FIELD`, `ConstraintViolation→500 CONSTRAINT`, `DbError→500 DATABASE_ERROR`, `GithubApiError→502 GITHUB_API_ERROR`, `GithubWebhookError→400 GITHUB_WEBHOOK_ERROR`, `InvalidKey→401 INVALID_API_KEY`, `MissingAuth→401 MISSING_AUTH`.

# Appendix B — Known adaptation points (check at implementation time, note deviations)

1. TanStack Start Cloudflare/Vite plugin wiring + API-route file convention (version-sensitive).
2. `cloudflare:workers` module exports (`env`, `waitUntil`) — verify against installed `@cloudflare/workers-types`.
3. `effect` version: if `@effect/schema` is merged, use `Schema` from `effect`.
4. Departure Mono availability on Google Fonts — fallback: JetBrains Mono for micro labels (DESIGN_SYSTEM.md §Typography lists the fallback).
5. `fractional-indexing` export names (`generateKeyBetween`) — confirmed stable, but check on install.

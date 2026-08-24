# Herald implementation plan — AI revamp

> **Status:** approved-direction spec + phased plan. Implementation not started.
> **Superseded in part** by the Hearth refactor plan (docs change set, 2026-08-23):
> umbrella renamed Forge → Hearth; exactly two builtin agents (`hearth-herald`,
> `hearth-blacksmith` — migration 0013 id rebind, generic 'lexa' retired);
> per-project engine switching (`herald_settings.engine`) with personal-overlay
> member toggle; vision chain (`primary_supports_images` / `vision_model` /
> `VISION_NOT_CONFIGURED`); chat guard `ENGINE_NOT_SUPPORTED_FOR_CHAT`.
> Where this doc conflicts with those decisions or with
> `docs/ADR-0001-two-tier-ai-architecture.md` (Amendments 2026-08-23),
> the Hearth refactor wins.
> Companion research: `docs/CLOUDFLARE_WORKERS.md` ("Assistant path via TanStack AI").
> Decided 2026-08-22.

## Goal

Add **Herald** assistant tier (server-side TanStack AI `chat()`) beside the active
**Blacksmith** coding tier under the Hearth umbrella. Blacksmith path untouched.
Both tiers co-exist; popover picks per-run.

**Stack:** `@tanstack/ai` 0.47.x pinned · Effect-TS services · bun:sqlite repos · SSE · TanStack Query.

## Global constraints

- Names exact: `/api/herald/*`, `herald_threads`, `project_memory`. Existing `/api/forge/*` + `forge_*` untouched except one `kind` predicate.
- Wireframe-first non-negotiable; PHOSPHOR primitives verbatim from `docs/design-system.html`; ported classes land in `app/styles/phosphor.css`.
- TanStack Query: `setQueryData` from mutation responses only; never `invalidateQueries` on mutation path.
- TipTap JSON boundary; markdown only via `shared/markdown.ts`.
- Activity invariant #12 same-tx emission, catalog messages.
- Migration number **0010** (0009 = in-flight attachments).
- Never touch attachments files (`migrations/0009_attachments.sql`, attachment repo/service).

# SPEC

## S1. Two active tiers

| | Herald | Blacksmith |
|---|---|---|
| Role | Writing + PM assistant | Coding agent |
| Engine | Server-side `chat()` (@tanstack/ai) | daemon/opencode warm serve |
| Queue consumer | HTTP stream handler, in-process | daemons via `claimNextTask` |
| Auth | Browser cookie/Bearer | x-forge-token surfaces |
| Thread state | `herald_threads` (ModelMessage[] JSON) | `forge_sessions` |
| Agents/skills render | prompt injection via systemPrompts | `.agents/` file writes |

Shared: `forge_tasks` queue, **Lexa Agents/Skills** catalog (tables `lexa_agents`/`lexa_skills`/`lexa_agent_skills` — renamed from `forge_*` in 0010; routes `/api/agents`, `/api/skills`), popover entry, logs/activity machinery. Umbrella = Hearth (internal `forge_*` identifiers deferred). Both tiers ACTIVE — no dormant wording anywhere.

## S2. Herald execution path

1. `POST /api/herald/tasks` `{documentType, documentId, prompt, agentId, skillId}`.
2. `HeraldService.enqueue`: guard provider configured (`PROVIDER_NOT_CONFIGURED`); create `forge_tasks` row `kind='herald'`, status `queued`; activity via existing create path. Runtime-online guard skipped.
3. Client opens `POST /api/herald/tasks/:id/stream`. Handler claims task (conditional UPDATE `queued→running`, kind-scoped), assembles prompt, calls `chat()`, pipes frames.
4. Prompt assembly (cache-friendly order):
   - `systemPrompts[0]`: identity + MARKDOWN_STYLE contract + `project_memory` block — Anthropic `cache_control` breakpoint here.
   - `systemPrompts[1]`: `agentMarkdown` + `skillMarkdown` — breakpoint here.
   - `systemPrompts[2]`: prefetched repo content (existing `loadTaskRepoContent` semantics) + document context via `shared/markdown.ts`.
   - user message: instruction (+ rolling-summary segment when present).
   - Object form `{content, metadata}` carries `cache_control` (verified).
5. Adapter by `herald_settings.kind`: `openai_compatible` | `anthropic_compatible`, both custom `baseURL`-capable (verified). OpenRouter = example only.
6. Terminal: `done` frame then `ForgeService.complete(taskId, finalText)` (same-tx activity); `RUN_ERROR` event translated per S5/S9 + `ForgeService.fail`.

Keys server-side only.

## S3. Provider settings model

```sql
CREATE TABLE herald_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('openai_compatible','anthropic_compatible')),
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  search_provider TEXT,          -- 'exa' | NULL (web_search disabled)
  search_api_key TEXT,
  url_allowlist TEXT,            -- comma-separated hostnames; empty = all allowed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **Per-project config** (review decision 2026-08-22) — each project picks endpoint/model; enables per-team provider choice.
- Routes scoped: `GET/PUT /api/herald/settings/:projectId`, `POST /api/herald/settings/:projectId/test`.
- GET returns masked view `{kind, baseUrl, model, hasKey:true, keyMask:"sk-…abcd", searchProvider, hasSearchKey, urlAllowlist}` — keys never serialized (plaintext at rest by decision).
- PUT: omitted keys keep stored values.
- Test: builds adapter from submitted values (unsaved), minimal completion ping + optional Exa ping; returns `{ok, latencyMs}` or `PROVIDER_AUTH_FAILED` / `PROVIDER_UNREACHABLE`. Never persists.
- `POST /api/herald/settings/:projectId/models`: lists models from provider using submitted unsaved values — OpenAI wire: `GET {base}/models`; Anthropic wire: `GET {base}/v1/models` with `x-api-key` + `anthropic-version`. Base URL normalized per kind (`/v1` appended when absent). Returns `{models:[{id}]}`. Some compat endpoints lack the route — manual model entry always available as fallback.
- Enqueue guard: calling project must have a settings row, else `PROVIDER_NOT_CONFIGURED`.

## S4. Queue integration

Reuse `forge_tasks` + discriminator column:

```sql
ALTER TABLE forge_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'blacksmith';
CREATE INDEX idx_forge_tasks_kind_status ON forge_tasks(kind, status);
```

- `claimNextTask` gains `AND kind='blacksmith'` — daemons can never claim Herald tasks.
- New `claimHeraldTask(id)`: conditional UPDATE `status='queued' AND kind='herald'` → `running`.
- Status transitions, result cap 1MB, error cap 2KB, `appendLog` FIFO 400, sweeps, cancel reused unchanged.

Rejected alternative (recorded): separate `herald_tasks` table — duplicates queue/status/log/activity/cancel machinery for zero gain.

## S5. SSE stream endpoint

`POST /api/herald/tasks/:id/stream` (POST + fetch-stream; not EventSource-GET). Browser auth middleware. Frames:

```
event: start   data: {"taskId":"…","threadId":"…"}
event: delta   data: {"text":"…"}
event: tool    data: {"phase":"call|result","name":"…","arg":"…"}
event: error   data: {"code":"HERALD_GENERATION_FAILED","message":"…"}
event: done    data: {"taskId":"…","text":"…","usage":{"in":n,"out":n}}
```

- Exactly one terminal frame (`error`|`done`). Heartbeat `: ping` every 15s.
- `RUN_ERROR` translation: recognizable failures → catalog codes, else `HERALD_GENERATION_FAILED`; emit frame; close cleanly; `ForgeService.fail`.
- Disconnect→abort: request signal wired into `chat()` AbortController; abort discards partial message, `ForgeService.cancel`, `appendLog("aborted")`.
- Stop button: client aborts fetch + `POST /api/herald/tasks/:id/cancel`; server keeps `Map<taskId, AbortController>`.
- Subrequest budget: `MAX_TOOL_ROUNDS=4`; worst case ≈9 upstream calls/task (provider turn + one upstream per tool call); counter logged per run.

## S6. Thread / session model

```sql
CREATE TABLE herald_threads (
  document_type TEXT NOT NULL CHECK (document_type IN ('task','wiki','chat')),
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT,                    -- required for chat threads; ownership enforced
  agent_id TEXT,
  skill_id TEXT,
  messages TEXT NOT NULL DEFAULT '[]',   -- ModelMessage[] JSON
  summary TEXT,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_type, document_id)
);
```

Continue-vs-fresh (mirrors `resolveSessionForTask` minus runtime):

| Condition | Action |
|---|---|
| Same doc + same agentId+skillId, thread exists | Continue |
| Agent or skill changed | Fresh (overwrite row) |
| No thread | Create on first turn |
| Reset `DELETE /api/herald/threads/:documentType/:documentId` | New thread; `HERALD_TASK_ACTIVE` 409 while running |

Model/provider change does NOT reset thread.

Rolling summary: after `done`, if messages >40 entries or >64KB — summarize all-but-last-8 into `summary` (cheap call), truncate window to last 8. Summary failure: log, skip, retry next turn — never blocks `done`.

Repo shaped to `withPersistence` floor: `loadThread(doc)` / `saveThread(doc, ModelMessage[])` — future D1 swap touches repo only.

## S7. Tools v1 — ACTIVE

| Tool | Backing | Guards |
|---|---|---|
| `web_search(query)` | **Exa API** (`POST https://api.exa.ai/search`, `x-api-key`); enabled iff `search_provider='exa'` | top-k 5, title+url+snippet only, snippet cap |
| `fetch_url(url)` | Plain `fetch` + HTML→text extraction; **PDF supported v1** (content-type `application/pdf` → text extraction, ≤5MB / ≤50 pages) | http(s) only; block localhost/private/reserved ranges incl. `169.254.169.254`; re-validate every redirect hop; 15s timeout; ≤512KB text / ≤5MB pdf; **`url_allowlist` enforced when non-empty** (hostname suffix match) |
| `read_s3_file(key)` | Existing `Lexa/Storage` service (R2/S3 driver from attachments work) | Scoped to current project's attachments; size cap; no credential exposure; no cross-project reads |

- Tool frames stream as `tool` events (phase call/result) → UI chips.
- Infra: `toolDefinition().server(fn)`; PM read tools (`get_task` accepting `PREFIX-n` alias per invariant #13, `search_tasks`) ride along when trivial.
- Write tools deferred entirely (not approval-gated) until v2 — approval UX has no wireframe states yet; Lexa→GitHub writes are route-orchestrated only (invariants #1/#2).

## S8. Memory layer — `project_memory`

Curated judgment-type facts only (decisions/constraints/preferences), never task data.

```sql
CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | herald
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE project_memory_fts USING fts5(content, content='project_memory', content_rowid='rowid');
```

FTS sync app-managed in repo (no triggers). Injection: FTS-match top terms from task title + description text nodes at enqueue; K=5 hits, 2000-char cap; bulleted block into `systemPrompts[0]`; empty = omitted. Curation v1 = CRUD endpoints + settings list UI. D1 caveat: no FTS5 there — repo behind narrow interface, LIKE fallback swappable.

## S9. Error catalog additions

| Code | HTTP | When |
|---|---|---|
| `PROVIDER_NOT_CONFIGURED` | 409 | generate/test without saved settings |
| `PROVIDER_AUTH_FAILED` | 502 | upstream 401/403 (provider or Exa) |
| `PROVIDER_UNREACHABLE` | 502 | network/timeout/DNS |
| `HERALD_GENERATION_FAILED` | 502 | RUN_ERROR catch-all, malformed stream |
| `HERALD_TOOL_BUDGET_EXCEEDED` | 502 | round cap hit |
| `HERALD_TASK_ACTIVE` | 409 | reset while stream running |
| `HERALD_THREAD_NOT_FOUND` | 404 | missing thread row |

All `Data.TaggedError`, declarative `.addError` mapping. Upstream bodies never echoed raw. Activity: reuse existing forge task catalog entries; zero new `activity-messages.ts` entries v1.

## S10. UI states (wireframe-first)

| State | Surface | Behavior |
|---|---|---|
| Mode picker | Popover header | Herald/Blacksmith segmented control, per-run |
| Provider-not-configured | Herald panel | empty state + CTA to Settings provider section |
| Streaming | Popover/editor | live deltas into preview, mono raw-markdown, auto-scroll, stop button visible |
| Tool progress | Streaming panel | chips from `tool` frames ("Searching web…", "Reading file…") |
| Image attach | Composer | paste/pick images, thumbnail previews, remove; caps enforced client-side hint + server-side hard |
| Done | Popover/editor | insert converts md via `shared/markdown.ts`; cache via `setQueryData` |
| Failed | Popover | code + message from `error` frame, retry affordance |
| Provider settings | Settings | **per-project section**: kind select, baseUrl, apiKey password field (masked when set), model combobox (Fetch models → dropdown from provider list, free-text fallback), search provider + key, url allowlist, Test connection pending/ok/fail, Save |
| Memory curation | Settings | per-project list/add/delete |

New files under `wireframes/src/`, annotation tags mandatory, build.sh gate.

## S11. Observability

Parity via existing `appendLog` (2000-char bound, FIFO 400): provider kind/model/host (never key), prompt sizes, tool calls + subrequest counter, usage tokens, aborts, RUN_ERROR translations, summary compactions. Deltas NOT logged. Readable through existing task-log polling hooks.

## S12. Churn containment + portability

- Pin `"@tanstack/ai"` exact 0.47.x, no caret. Adapters isolated in `server/herald/provider.ts`; `chat()` imported in exactly one file. Upgrade touches two files.
- `Lexa/Herald` Effect service surface: `enqueue`, `runStream(taskId): ReadableStream`, `resetThread`, `testConnection`. Routes never import @tanstack/ai.
- Types in NEW `shared/herald.ts` (declared deviation from `shared/types.ts` home — dirty-tree avoidance; consolidation later only with user approval).
- `loadTaskRepoContent` pure-move extract into `server/services/forge-repo-content.ts`; both tiers share it.
- Worker-portability goals (not migration target): exported caps, Web ReadableStream SSE, no Node APIs in `Lexa/Herald` path, bun:sqlite confined to repos, persistence-floor-shaped store, FTS behind interface. PDF extraction should prefer a workerd-compatible lib (unpdf-style) over Node-native.

## S13. Multimodal input (images)

Verified SDK facts: `ImagePart` = `{type:'image', source:{type:'data', value:<base64>, mimeType}|{type:'url', value}}`; both custom-endpoint paths translate natively (`openaiCompatible` → OpenAI `image_url` with auto data-URI wrap; `anthropic` → base64/url source blocks); documents map to PDF source blocks on Anthropic; **no SDK downsampling/limits — host-app territory**.

- Flow: images attached in popover → stored via `Lexa/Storage` (same pipeline as attachments) → transcript persists a storage-ref form → **hydrated to base64 `data` parts at call time** (self-hosted storage URLs aren't reachable by providers — never use `url` source).
- Caps: ≤5 images/message, ≤5MB each, `png/jpeg/gif/webp` only.
- Capability gating caveat: `openaiCompatible` defaults bare-string models optimistically to `['text','image']` typing — no compile-time protection for custom endpoints. Upstream 400 on vision-incapable model maps to `HERALD_GENERATION_FAILED` with explicit "model may not support images" message. No settings flag v1.
- Rolling summary: window truncation drops old images naturally; summaries stay text-only.

## S14. Catalog rename — Lexa Agents/Skills

Catalog is the behavioral spec for BOTH tiers — `forge_` prefix mislabels it.

```sql
ALTER TABLE forge_agents RENAME TO lexa_agents;
ALTER TABLE forge_skills RENAME TO lexa_skills;
ALTER TABLE forge_agent_skills RENAME TO lexa_agent_skills;
```

- Other `forge_*` tables keep names (`forge_tasks`, logs, sessions, runtimes/events/machines) — queue stays under the Hearth umbrella (identifier rename deferred). Indexes follow tables; legacy index names left as-is.
- Route moves — hard cutover, no aliases (sole consumer is bundled web app): `/api/forge/agents…` → **`/api/agents…`**, `/api/forge/skills…` → **`/api/skills…`** incl. junction subpaths.
- **Kept:** claim payload field names `agentMarkdown`/`skillMarkdown` (wire compat with compiled prod daemons during rolling upgrades); `AgentSkillSettings.tsx` filename.
- **Renamed:** `shared/types.ts` `ForgeAgent`/`ForgeSkill` → `LexaAgent`/`LexaSkill`; hooks `useForgeAgents/useForgeSkills` → `useAgents/useSkills`, query keys `['agents']`/`['skills']`; UI labels "Lexa Agents"/"Lexa Skills" everywhere.
- ⚠️ Table names live in SQL strings — NOT compile-time caught. Atomic single-migration rename; repo+service vitest suites mandatory; P4 grep gate: zero hits for old names outside migrations.

## S15. Herald Chat — freeform assistant surface

Standalone chat beside the Herald popover; same engine, not tied to a document.

- **Thread:** one persistent thread per (project, user) v1 — `document_type='chat'`, `document_id`=client uuid, ownership via `owner_user_id` (mismatch → 404). Multi-thread history deferred; reset covers fresh start.
- **No queue row** — direct synchronous SSE request/response (interactive; queue machinery adds nothing).
- Endpoints:
  - `POST /api/herald/chat/stream` `{projectId, chatId, message, agentId?, skillId?, attachments?}` → S5 frames minus taskId
  - `GET /api/herald/chat/:chatId` → transcript for reload/scrollback
  - `DELETE /api/herald/chat/:chatId` → reset; 409 `HERALD_TASK_ACTIVE` while streaming
- Concurrency: `Map<chatId, AbortController>`; second concurrent stream → 409. Disconnect→abort identical to S5.
- Differences vs document-Herald: no repoContent prefetch; identity segment = `CHAT_IDENTITY` variant (conversational, no insertion contract); memory query terms = current message text; no activity rows (invariant #12 N/A); tools identical incl. Exa search per S3/S7.
- Chat image caps (tighter than S13): ≤3/message, ≤1.5MB total request; rolling-summary counts TEXT bytes only — evicted images summarized away.
- Observability v1: structured server logs only (provider/model/host, usage, aborts, RUN_ERROR translations) — no DB log table.
- UI states (placement route-vs-slide-over = designer P1): composer w/ send+stop+image attach, streaming bubble, error banner + retry, reset confirm, agent/skill picker (shared component), provider-not-configured empty state (reuse), transcript render on load, busy-409 state.

### Phase deltas (S14/S15)

| Phase | Delta |
|---|---|
| P1 | + chat surface states; "Lexa Agents/Skills" labels in picker + settings wireframes |
| P2 | + three RENAME statements; CHECK +'chat'; project_id NOT NULL + owner_user_id; gate adds `PRAGMA foreign_key_list` paste |
| P3 | + renamed statements in forge.repo.ts; chat access fns on herald-thread.repo.ts (owner-scoped); tests cover renamed tables + owner guard |
| P4 | + runChatStream path (no prefetch, CHAT_IDENTITY, message-term memory); rename refs across forge.service.ts; grep gate zero-hits |
| P5 | + top-level /api/agents,/api/skills groups replacing forge-group CRUD; + chat stream/GET/DELETE + 409 concurrency; smoke gains chat cases |
| P6 | + AgentSkillSettings retarget + labels; hook/key renames; + chat UI components |
| P7 | + API.md moved routes + chat endpoints; LAYERS.md rename + chat pattern; branding sweep |
| P8 | + chat round-trip smoke (send/stream/reload/reset/409); Blacksmith regression: bundles still render from payload |

# PHASED PLAN

Graph: **P0 gates all dirty-file work. P1 gates P6 only.** P2→P3→P4→P5 sequential. P1 parallel-safe with P2–P5.

### P0 — Preflight (user) — S
Commit/stash attachments work; `git submodule update --init wireframes`.
Gate: `git status --porcelain` clean of shared files; `ls wireframes/src/` non-empty.

### P1 — Wireframes (@designer) — M — FIRST
Files: new `wireframes/src/*.html` covering ALL S10 states (incl. tool-progress chips + image attach/preview) + design-system.css additions. Annotations mandatory; primitives verbatim; no JS.
Gate: `bash wireframes/build.sh` exit 0; accessibility snapshot confirms each state; user eyeballs previews. **No React dispatch before gate.**

### P2 — Migration + types — S
Create: `migrations/0010_herald.sql` (S3+S4+S6+S8 SQL verbatim); `shared/herald.ts` (masked settings view, StreamFrame union, thread types).
Gate: fresh DB migrate passes; `.schema herald_threads` paste; `tsc --noEmit`.

### P3 — Repos — M
Create: `server/repos/herald-settings.repo.ts`, `herald-thread.repo.ts` (loadThread/saveThread/resetThread/summary), `project-memory.repo.ts` (CRUD + FTS sync + searchByProject).
Modify: `server/repos/forge.repo.ts` — createTask kind param, claim predicate, claimHeraldTask.
Tests: vitest per repo, in-memory sqlite.
Gate: scoped `vitest run` green; `tsc --noEmit`.

### P4 — Services (@tanstack/ai lands here) — L
Create: `server/services/herald.service.ts` (`Lexa/Herald`), `server/herald/provider.ts` (adapters + testConnection + listModels), `server/herald/prompt.ts`, `server/herald/tools.ts` (**active**: web_search/fetch_url/read_s3_file + SSRF guard module + allowlist enforcement + PDF extraction), `server/services/forge-repo-content.ts` (pure move from http.ts).
Modify: `package.json` exact pins (@tanstack/ai, exa client or plain fetch, unpdf-style).
Tests: fake-fetch adapter units; prompt assembly snapshot; continue-vs-fresh matrix; RUN_ERROR translation; SSRF unit tests (private-IP rejection, redirect re-validation, allowlist); multimodal hydration (storage-ref → data part) + cap enforcement.
Dependency note: `read_s3_file` phase-gates behind attachments/storage work landing (P0).
Gate: `vitest run` green; `tsc --noEmit`.

### P5 — API routes — L
Modify: `server/api/http.ts` — `heraldGroup`: settings GET/PUT/test, tasks POST, stream POST, cancel POST, threads DELETE, memory CRUD; `.addError` per S9.
Smoke script `scripts/herald-smoke.sh`: unauth 401; missing config 409; bad key test; models-list happy path; happy-path SSE frame sample incl. `tool` frame.
Gate: pasted curl outputs; `tsc --noEmit`.

### P6 — React transcription (@designer lane; blocked by P1 gate) — L
Create: `app/lib/use-herald-stream.ts` (fetch reader + AbortController), forge components (mode picker, streaming panel, tool chips, stop button, empty state), settings provider + memory components.
Modify: `app/lib/api.ts`, `app/lib/queries.ts` (`setQueryData` discipline), `app/styles/phosphor.css` (port wireframe classes).
Rules: transcribe completed wireframe exactly; insert converts via `shared/markdown.ts`.
Gate: `tsc --noEmit`; `bun run dev:full` manual QA checklist paste (each S10 state); `vitest run`.

### P7 — Docs — S/M
Update: `docs/ADR-0001-two-tier-ai-architecture.md` (written 2026-08-22 — keep in sync if decisions shift), `docs/API.md` (herald endpoints), `docs/LAYERS.md` (`Lexa/Herald` pattern + catalog rows), `docs/ARCHITECTURE.md` (two active tiers rationale), `docs/CLOUDFLARE_WORKERS.md` (verify co-exist wording current).
Gate: grep confirms no stale tier wording; cross-refs valid.

### P8 — Final verification — S
`tsc --noEmit` · `vitest run` · `bash wireframes/build.sh` · `bun run dev:full` smoke: create task, stream, tool chip appears, stop mid-stream, reset thread, settings round-trip; existing Forge/GitHub acceptance checks unaffected.

# RISKS

| Risk | Mitigation |
|---|---|
| Dirty tree: attachments owns `http.ts`, `docs/API.md`, `shared/types.ts` | P0 hard gate; types isolated in `shared/herald.ts` meanwhile |
| TanStack AI 0.x churn | Exact pin; single import seam; snapshot tests |
| SSRF via fetch_url | Scheme/IP/redirect guards + allowlist + caps; unit-tested |
| Storage dependency for read_s3_file | Phase-gate behind attachments landing |
| Subrequest budget (Workers future) | Exported caps; counter logged per run |
| D1 future lacks FTS5 | Memory repo behind narrow interface; LIKE fallback |
| SSE buffering via cloudflared/proxies | 15s heartbeat; verify in P8 smoke |
| `claimNextTask` hot-path edit | One predicate + index; blacksmith tests stay green |
| Key leakage | Never serialize api_key/search_api_key; logs redact; fixed error strings |
| Exa API churn | Thin fetch wrapper, provider field swappable |
| Transcript bloat from base64 images | Storage-ref persisted in thread; hydrated at call time; window truncation drops old images |
| Rename blast radius — table names in SQL strings are runtime-only failures | Atomic single-migration rename; mandatory repo+service vitest suites; P4 grep gate zero-hits outside migrations |
| Chat bypasses queue safeguards (sweep/cancel) | Accepted: synchronous lifetime bounded by request; disconnect abort covers abandonment |

# Resolved decisions log

- Provider: custom OpenAI-/Anthropic-compatible endpoint (OpenRouter example only)
- Search: Exa; disabled when `search_provider` NULL
- URL allowlist: yes, optional setting, enforced in fetch_url
- PDF: v1, via workerd-compatible extraction, 5MB/50-page caps
- Tools: active v1 (reads only); writes deferred to v2
- Multimodal: images in v1 (≤5/msg, ≤5MB, png/jpeg/gif/webp); storage-ref persisted, hydrated to base64 at call time; no settings flag — upstream 400 maps to explicit error
- Catalog renamed **Lexa Agents/Skills** (`lexa_*` tables, `/api/agents`+`/api/skills` routes); claim payload field names kept for daemon wire compat
- **Herald Chat** added: freeform assistant surface on same engine; no queue row, one thread per (project,user), direct SSE
- Review outcomes (2026-08-22): keys plaintext at rest · provider config **per-project** · Herald tasks visible+badged in Forge surfaces · threads kept forever (no prune)
- Model picker: fetch models from provider endpoint (per-kind wire format, base-URL normalized); free-text fallback always available
- Defaults taken (no user input needed): no sampling params in settings v1 (provider defaults) · PM read tools tasks-only v1 (wiki later) · settings surface mount point = designer's call during P1
- Tiers: Herald + Blacksmith both ACTIVE, co-exist; Hearth umbrella (renamed from Forge, 2026-08-23)

# Cloudflare Workers hosting — Workers flavor HOW

> **Status:** design authority — Workers flavor (decision formerly ADR-0002,
> now merged into this file). Researched 2026-08-22 against current Cloudflare/TanStack/Effect
> docs; decision accepted 2026-08-25. This doc is the canonical HOW (library/quirk
> reference) and now also carries the WHY/decision summary — see §Decision summary below.

## Decision summary (merged from ADR-0002)

Add a second, fully independent hosting flavor — **Workers + D1 + R2** — that
coexists with the existing Bun+Docker flavor. Two flavors are peer-level; neither
replaces the other; either or both can be live at any time.

1. **Runtime split:** two flavors, separate users. Each flavor has its own domain,
   DB, attachment bucket, settings, and lifecycle. Same source tree builds both via
   a Vite plugin chain that emits two server bundles (Bun entry + Workers entry).
2. **Data layer:** one repo, two drivers. `server/db/drivers/bun-sqlite.ts` and
   `server/db/drivers/d1.ts` both implement `DbDriver`. Repos are async; the
   `bun-sqlite` driver wraps the sync API in `Promise.resolve`, so existing code-shape
   is preserved.
3. **Atomicity invariants re-expressed:** the emission invariant (mutation +
   `task_activity` in one atomic unit) and the webhook atomic move +
   `github_synced_state` write become pre-computed `{ sql, params }[]` arrays passed
   to `db.batch()`. The WIP-limit conditional UPDATE stays a single statement.
   Read-modify-write sites that aren't strict emissions stay as-is.
4. **Env access:** `server/env.ts` returns a `RuntimeEnv` — `process.env` on Bun,
   `env` from `cloudflare:workers` on Workers. Every module-scope `process.env.X`
   read goes through this helper. `server/auth.ts` becomes `createAuth(env)`, a
   per-request factory.
5. **Storage:** Workers uses the R2 native binding (driver kind `"r2"`); Bun keeps
   `fs` and `s3` (S3 covers R2's S3 endpoint for Bun-side users). The `StorageDriver`
   interface is unchanged.
6. **No data sync between flavors.** A user who wants to move from Bun to Workers
   dumps the Bun DB to SQL and replays it on D1 manually. `lexa-cli deploy workers
   --seed` re-applies the dev seed file.
7. **Deploy surface:** `lexa-cli deploy <domain> [bun|workers] [staging|prod]` is the
   operator's pick point. The Bun flavor uses the existing Docker+cloudflared flow.
   The Workers flavor provisions D1+R2+KV+Worker route via the Cloudflare API and
   ships a prebuilt bundle. See `docs/DEPLOYMENT.md` for the dispatch.
8. **Cron + observability:** Workers' `scheduled` handler runs prune + backup (cron
   `*/15 * * * *`); `wrangler.jsonc` enables observability. The Bun path keeps its
   `setInterval`.
9. **Compliance gate:** `scripts/check-invariants.ts` scans the source tree for the
   14 architectural invariants listed in `AGENTS.md` and fails any PR that introduces
   a violation. This is the durable record of the invariants for future contributors.

Alternatives rejected: status quo (Bun only), Workers-only cutover, single-domain
warm backup, D1 canonical + sqlite mirror, one-way export — see §Decision summary above for full
rationale. Consequences and compliance notes #1–14 preserved there (positive:
$5/mo flat infra, async driver shape, invariant guard rails, R2 binding contained to
`server/storage/`; risks: D1 no interactive tx / 30s batch ceiling / sequential
execution, `lastInsertRowid` unreliable on D1, wide `createAuth(env)` refactor,
pre-1.0 version pins, two deploy surfaces, regex compliance script).


Migrating Lexa to Cloudflare Workers is **feasible — no hard blockers** — but it is a
real migration, not a redeploy. The price is an async rewrite of the entire persistence
layer (bun:sqlite → D1) and a transaction-semantics redesign against the atomicity
invariants. What it buys: no VPS process, no tunnel, git-push-style deploys,
**$5/mo flat infra** at 5–10 user scale.

## Cost (5–10 users)

| Item | Free tier | Paid |
|---|---|---|
| Workers compute | $0 (100k req/day, 10ms CPU) | $5/mo base |
| Request overage | — | $0 (10M/mo included ≫ usage) |
| D1 reads/writes/storage | $0 | $0 (25B reads / 50M writes / 5GB included) |
| R2 attachments | $0 (10GB, 1M Class A / 10M Class B per mo) | $0.015/GB-mo beyond; egress always $0 |
| Tunnel | $0 (eliminated entirely on Workers) | $0 |
| Access gating ≤50 users | $0 | $0 |

- **Total: $5/mo flat** (Workers Paid). Overages round to <$1 at this scale.
- Go Paid regardless: free D1 caps a database at **500MB hard**, and the 10ms CPU
  wall is too tight for SSR.
- LLM token spend excluded by decision (2026-08-22).

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Access](https://www.cloudflare.com/sase/products/access/).

## Feasibility by area

| Area | Verdict | Effort |
|---|---|---|
| TanStack Start on Workers | works-with-changes | M |
| Effect-TS on workerd | works-with-changes | M–L |
| bun:sqlite → D1 | works-with-changes | **L** (biggest area) |
| Better Auth + D1 | works-with-changes | S–M |
| GitHub webhook pattern | works natively | S |
| Env/secrets/migrations | works-with-changes | S–M |
| R2 storage driver | works-with-changes | M |
| TanStack AI assistant path | works-with-changes | S–M |

### TanStack Start

Official partner path: `@cloudflare/vite-plugin` + `tanstackStart()` in vite config;
`wrangler.jsonc` with `"main": "@tanstack/react-start/server-entry"`,
`"compatibility_flags": ["nodejs_compat"]`. Requires `@tanstack/react-start` ≥ 1.138.0.
SSR runs inside workerd via the Vite Environment API; the current split dev setup
(`vite proxy /api → :3000` + `bun server/entry.ts`) disappears — single `vite dev`,
API routes co-hosted with SSR.

Env is **per-request**: module-scope `process.env.X` is `undefined` on Workers.
Canonical access is `import { env } from "cloudflare:workers"` or the handler arg.
Affects every module-scope config read (API-key check, auth singleton).

Sources: [CF × TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/),
[TanStack hosting docs](https://tanstack.com/start/latest/docs/framework/react/guide/hosting).

### Effect-TS on workerd

Effect core runs on workerd. Breaks to replace: `@effect/platform-node*` /
`platform-bun` layers, `Bun.serve` entry, `bun:sqlite` driver. Upstream
`@effect/sql-d1` driver exists.

Known landmine: lazy layer build inside the first request
(`HttpApp.toWebHandlerLayerWith`, `RpcServer.toWebHandler`) can leave a pending
promise forever when the first request aborts → isolate wedged, error 1101
([effect#6319](https://github.com/Effect-TS/effect/issues/6319)).
Mitigation: eager-build the handler at module scope. Per-request bindings vs
module-scope Layers forces a service-architecture change (factory-per-request or
ManagedRuntime rebuilt on env change).

### bun:sqlite → D1 (the real cost)

API near-isomorphic but **sync → async everywhere**:

| bun:sqlite | D1 |
|---|---|
| `.prepare(sql).all(...p)` | `.prepare(sql).bind(...p).all()` → `{results}` |
| `.get(...)` | `.bind(...).first()` |
| `.run(...)` → `.changes` | `.bind(...).run()` → `.meta.changes` |

SQL itself unchanged. Drop `PRAGMA journal_mode=WAL` (managed by D1); FK enforcement
ON by default. FTS5 and partial unique indexes are supported (Backlog partial-unique
and `UNIQUE(issue_id)` safe). Hard 10GB storage cap. Single-threaded sequential query
execution — overload queues, then errors when the queue fills.

**No interactive transactions** (`BEGIN/COMMIT/ROLLBACK` unsupported). Atomicity =
`db.batch([stmts])` only; whole batch must resolve < 30s. Direct hit on two
architectural invariants:

- Emission invariant (mutation + `task_activity` rows in the SAME transaction)
- Webhook atomic move + synced-state write

Both must be re-expressed as pre-computed statement batches. Silent invariant
breakage risk if any service interleaves reads between writes. The conditional WIP
UPDATE stays fine (single statement). Read-anchor→generate-position stays two round
trips; existing `isPositionConflict` retry-once maps cleanly.

### Better Auth

Native D1 support since v1.5 (Feb 2026): pass the binding directly
(`database: env.DB`), Kysely D1 dialect, uses `batch()` internally. Cookie sessions
need no Node APIs. Required refactor: auth instance becomes a **per-request factory**
taking `env.DB`. Pass `ctx.waitUntil` via `advanced.backgroundTasks` (post-response
writes otherwise die with "Network connection lost"). Gotchas: `@better-auth/cli
generate` introspection hits forbidden `_cf_METADATA`; `cookieCache` + KV secondary
storage broken ([better-auth#4203](https://github.com/better-auth/better-auth/issues/4203)) — disable cookieCache.

### Webhooks — maps natively

Raw-body-before-parse (`request.arrayBuffer()`), HMAC-SHA-256 via WebCrypto
`crypto.subtle` — no Node crypto. `ctx.waitUntil` extends execution up to 30s after
the response (GitHub times out deliveries at 10s — ample). CPU cost of HMAC + few D1
writes is ms-scale. Post-ack atomic work must fit `batch()` (see above).

### Env/secrets/filesystem

- Secrets via `wrangler secret put`; injected per-request.
- `GITHUB_PRIVATE_KEY_FILE` (path-based PEM) **impossible** — no filesystem. Use
  inline `GITHUB_PRIVATE_KEY` secret (already supported per `docs/GITHUB_SETUP.md`).
- Migrations: `wrangler d1 migrations create/apply`; seed via
  `wrangler d1 execute --file`. Replaces `scripts/dev.sh` boot + `seed-dev.sql`.
- cloudflared tunnel dropped entirely — Worker custom domain replaces it;
  `lexa-cli deploy` compose flow obsolete for the web tier.
- Hearth daemons unaffected — already external machines reached over HTTP; outbound
  subrequest budget 50/request free, 1000 paid.

## Object storage (R2)

Fits the agreed `Lexa/Storage` design (fs + s3 drivers):

- **R2 native binding driver**: put/get/head/list/delete, conditional writes
  (`onlyIf`), multipart uploads (parts ≥ 5MiB), range reads, zero egress, no creds
  in env.
- **Presigned URLs are NOT available from the binding** (secret key never reaches
  runtime). Presigning needs S3 credentials + `aws4fetch` SigV4 (Web Crypto, tiny).
  Proven hybrid pattern: binding for data plane, aws4fetch only for presigning.
- Presigned POST forms unsupported (no size-cap enforcement at bucket); Worker-proxied
  body capped at 100MiB → design attachment flow as **presigned-PUT direct-to-R2
  first**, enforce max size server-side before signing.
- Binding copy = read-then-write, non-atomic.
- The aws4fetch-based `s3` driver covers R2/Garage/MinIO unchanged (region `auto`,
  path-style). The `fs` driver stays Bun-host-only (no fs on Workers).
- No official Effect R2/S3 layer in `@effect/experimental` → thin ~50-line
  `Effect.tryPromise` wrapper around the binding (community `effect-cf` exists).
- Local dev: `wrangler dev` simulates R2 (miniflare-backed).

## Assistant path via TanStack AI

Current state (Aug 2026): `@tanstack/ai` 0.47.x, MIT, still 0.x (~24 minors in 3
months; one wire-format break already shipped). Core is web-standard JS — workerd-
clean. Official `@cloudflare/tanstack-ai` 0.2.1 exists (Workers AI binding + AI
Gateway routing; published from `cloudflare/ai`, not the TanStack monorepo).

Decision (2026-08-22): the chat() path IS the assistant tier — **Herald** (writing
assistant and PM assistant). The daemon/opencode runtime remains for coding tasks —
**Blacksmith**; both tiers are active and co-exist under the Hearth umbrella (the
shared queue/catalog: `hearth_*` tables feed both tiers). See `docs/ARCHITECTURE.md` §Hearth — two active AI tiers.

Shape:

```
POST /api/hearth/tasks → queue → server-side chat():
  adapter       = openaiCompatible | anthropic — custom baseUrl + apiKey from
                  settings (both verified custom-endpoint-capable; OpenRouter is
                  only an example endpoint)
  systemPrompts = [agentMarkdown, skillMarkdown, taskContext]  // verified option;
                  // {content, metadata} form carries Anthropic cache_control
  tools         = toolDefinition().server(fn) — web_search/fetch_url (SSRF-guarded),
                  get_task/search_tasks reads; PM memory injected as a prompt
                  block (read-only) — PM writes deferred, no approval gate shipped
  middleware    = withPersistence → herald_threads (ModelMessage[] JSON)
→ SSE stream back (RUN_STARTED → TEXT_MESSAGE_CONTENT* → RUN_FINISHED | RUN_ERROR)
```

- Task/wiki context injected read-only via existing `shared/markdown.ts`
  (TipTap→markdown). Middleware hooks mutate prompts/model per request;
  `ctx.defer()` for post-stream DB writes; AbortController cancels on client
  disconnect.
- Rules/skills need no migration: `lexa_agents`/`lexa_skills` schema feeds BOTH
  renderers — prompt injection on this path, `.agents/` file writing on the daemon
  path. Skills may additionally declare tool bundles bound per call.
- Memory = three layers: Lexa DB via read tools (live truth, never memorized);
  thread transcripts (`withPersistence`, driver-agnostic store — bun:sqlite now,
  D1 later); curated `project_memory` FTS5 table for judgment-type facts only.
  Long threads roll into summary rows (explicit replacement for opencode's
  auto-compaction).
- Gotchas: terminal failure arrives as a `RUN_ERROR` event inside the stream, not a
  throw — the SSE bridge must translate it. Every loop iteration (provider call +
  tool subrequests) draws from the Worker subrequest budget (50 free / 1000 paid
  per request) — `maxIterations` + repo caps double as budget guards.
- Capability vs daemon+opencode path: repo/source reads covered (pre-fetch today,
  agentic `read_repo_file`-style tools when wanted); PM reads via injected memory
  block + task tools (PM writes deferred). Genuinely lost: shell/file-edit/exec,
  sandbox filesystem work — coding territory, which is what the Blacksmith
  runtime lane is for.
- **Verdict: replace for assistants, keep daemon for coding.** Both behind the same
  `Lexa/Hearth` service interface; UI labels modes distinctly.
- Churn risk: pin exact versions and wrap `chat()` behind the `Lexa/Hearth` service
  so SDK swaps stay contained.

## Top risks

1. **Sync→async DB rewrite + transaction semantics (L).** Every repo/service signature
   changes; emission invariant and webhook atomic move+synced-state must become
   pre-computed `batch()` statement arrays — silent invariant breakage if any service
   interleaves reads between writes.
2. **Effect runtime lifecycle on workerd.** Lazy layer-build hang (#6319) wedges
   isolates; per-request bindings vs module-scope Layers forces architecture change.
   Mitigation: eager module-scope runtime build, pinned Effect versions.
3. **D1 single-writer throughput + 30s batch ceiling.** Sequential execution queues
   under concurrency; kanban drag storms could hit overload errors. Load test before
   committing.
4. **TanStack AI 0.x churn** — pin versions, contain behind own service.
5. **Assistant-vs-coding capability cliff** — users may expect daemon-grade results
   from assistant runs; label the two modes distinctly in UI.

## Bottom line

Migration buys ops simplicity (no VPS process, no tunnel, simple deploys) and $5/mo
flat infra — not capability. The current Bun+tunnel design is already sound. The real
price is the L-effort async persistence rewrite plus re-expressing the atomicity
invariants as D1 batches. If pursued, first step: a D1 driver abstraction behind the
repo layer (`@effect/sql-d1` exists upstream) that keeps the Bun host working while
making a Workers deployment possible later.

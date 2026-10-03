# Cloudflare Workers hosting — Workers flavor HOW

> **Status:** design authority — Workers flavor (decision formerly ADR-0002,
> now merged into this file). Researched 2026-08-22 against current Cloudflare/TanStack/Effect
> docs; decision accepted 2026-08-25. This doc is the canonical HOW (library/quirk
> reference) and now also carries the WHY/decision summary — see §Decision summary below.

## Decision summary (merged from ADR-0002)

Add a second, fully independent hosting flavor — **Workers + D1 + R2** — that
coexists with the existing Bun flavor. Two flavors are peer-level; neither
replaces the other; either or both can be live at any time.

1. **Runtime split:** two flavors, separate users. Each flavor has its own domain,
   DB, attachment bucket, settings, and lifecycle. Same source tree builds both via
   a Vite plugin chain that emits two server bundles (Bun entry + Workers entry).
2. **Data layer:** one repo, two drivers. `server/db/drivers/bun-sqlite.ts` and
   `server/db/drivers/d1.ts` both implement `DbDriver`. Repos are async; the
   `bun-sqlite` driver wraps the sync API in `Promise.resolve`, so existing code-shape
   is preserved.
3. **Atomicity invariants:** the emission invariant (mutation +
   `task_activity` in one atomic unit) and the webhook atomic move +
   `github_synced_state` write are pre-computed `{ sql, params }[]` arrays passed
   to `db.batch()`. `batch()` is atomic on both drivers; `withTx` is a no-op on
   D1. Read-dependent sites either fold the read into the batch SQL (task-create
   counter, archive cascades) or accept an explicit read-compute-retry window.
   The WIP-limit conditional UPDATE stays a single statement.
4. **Env access:** `server/env.ts` returns a `RuntimeEnv` — `process.env` on Bun,
   `env` from `cloudflare:workers` on Workers. Every module-scope `process.env.X`
   read goes through this helper. `server/auth.ts` becomes `createAuth(env)`, a
   per-request factory. Workers configures everything through bindings and
   secrets (`wrangler secret put` / `wrangler.jsonc`); the Bun `.env.toml`
   loader does not exist on this target.
5. **Storage:** Workers uses the R2 native binding (driver kind `"r2"`); Bun keeps
   `fs` and `s3` (S3 covers R2's S3 endpoint for Bun-side users). The `StorageDriver`
   interface is unchanged.
6. **No data sync between flavors.** A user who wants to move from Bun to Workers
   dumps the Bun DB to SQL and replays it on D1 manually. The dev seed file is
   re-applied only via the dev bootstrap (`bun run setup` / the wizard's
   sample-data step) in every environment.
7. **Deploy surface:** `install.sh workers` is the operator's pick point —
   it fetches the release workers tarball, provisions D1+R2+KV via the
   Cloudflare API, applies D1 migrations, and deploys the prebuilt bundle via
   `bun x wrangler` (helper: `scripts/workers-install.ts`, `--name` keys the
   resource names). Repo deploys
   use `install.sh workers --from-repo <dir>`. A staging Workers environment
   deploys from a clone with plain `wrangler` (`wrangler.staging.example.jsonc`)
   — see `docs/DEPLOYMENT.md` §Staging from a clone. The Bun
   flavor is frozen and installs from a source checkout. See `docs/DEPLOYMENT.md`
   for the deploy flow. (`lexa-cli deploy` was removed in cli-v2026.2.0.)
8. **Cron + observability:** Workers' `scheduled` handler runs prune + backup
   (cron `*/15 * * * *`): `webhook_events` older than 7 days and
   `device_login_requests` past `expires_at` (same SQL as the Bun host's
   `setInterval` prune), plus R2 backup retention. The `*/15` trigger lives in
   `wrangler.jsonc` `triggers.crons` and is deployed with the Worker; a
   dashboard-only script upload does not carry triggers — add the cron in the
   dashboard settings on that path. `wrangler.jsonc` enables observability, and
   the installer transcribes that observability block from the root
   `wrangler.jsonc` into the per-deploy config. The Bun path keeps its
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
| TanStack AI assistant path | superseded by ADR-0003 — replaced by `@cloudflare/ai-chat` Durable Objects | M |

### TanStack Start

Official partner path: `@cloudflare/vite-plugin` + `tanstackStart()` in vite config;
`wrangler.jsonc` with `"main": "@tanstack/react-start/server-entry"`,
`"compatibility_flags": ["nodejs_compat"]`. Requires `@tanstack/react-start` ≥ 1.138.0.
Lexa keeps its own `main: server/workers-entry.ts`, which calls the Start handler
directly. Serving flow for non-API routes:

- `/share/*` → `handleSsr` — server-rendered (loader + `head` produce
  title/OG/description). The share lookup is D1-backed: `app/lib/share.server.ts`
  reads the binding via `import { env } from "cloudflare:workers"` and builds
  `DbD1Live`. That import is deliberately variable-held (`const pkg =
  "cloudflare:workers"`) and dynamic so the Bun build never tries to resolve it;
  workerd resolves it at runtime.
- other non-API → `handleNonShare`: try the prerendered `_shell.html` from the
  static-assets binding when present, else fall back to `handleSsr`. The
  install-generated per-deploy config binds the staged assets directory
  (`assets: { directory: "./assets", binding: "ASSETS" }`), so `env.ASSETS`
  exists and `getShellHtml` fetches `/_shell.html` — the fast path serves the
  prerendered shell and `handleSsr` stays the fallback (the Start handler emits
  the full root document for `ssr: false` routes). The Vite build manifest
  (`dist/server/wrangler.json`) still declares only `assets.directory`; the
  installer adds the binding. `injectEntryScript` patches each response
  individually; there is no module-global shell cache (the old `patchedShell`
  served the first route's HTML to every later one, so `/share/*` got the root
  shell).
- static files under `public/` land in `dist/client/` and are copied into the
  deploy's `assets/` dir, so the static-assets layer serves them without
  invoking the worker — `/favicon.svg` (declared in the root document head) and
  `/_shell.html` both ride this path.

The current split dev setup (`vite proxy /api → :3000` + `bun server/entry.ts`)
disappears — single `vite dev`, API routes co-hosted with the handler.

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
`db.batch([stmts])` only; the whole batch must resolve < 30s. `withTx` is a no-op
on D1, so multi-write sites use one batch. Direct hits, now handled:

- Emission invariant — mutation + `task_activity` rows in the same batch.
- Webhook atomic move + synced-state write — one batch.
- Read-dependent sites — task-create counter and archive cascades fold the read
  into the batch SQL; position anchoring / WIP verification keep an explicit
  read-compute-retry window (retry only on `isPositionConflict`, once).

The conditional WIP UPDATE stays a single statement.

### Better Auth

Native D1 support since v1.5 (Feb 2026): pass the binding directly
(`database: env.DB`), Kysely D1 dialect, uses `batch()` internally. Cookie sessions
need no Node APIs. Required refactor: the auth instance is built once per isolate,
keyed by an env fingerprint, taking `env.DB`. Pass `ctx.waitUntil` via `advanced.backgroundTasks` (post-response
writes otherwise die with "Network connection lost"). Gotchas: `@better-auth/cli
generate` introspection hits forbidden `_cf_METADATA`. Session cookie cache is
enabled (`session.cookieCache = { enabled: true, maxAge: 300 }` — it is read from
`session`, not `advanced`, where it would be a silent no-op): the signed
`better-auth.session_data` cookie (HMAC, compact strategy, keyed by a secret
derived from `LXK_SECRETS_MASTER_KEY` — fail closed if it is unset, never the
library-default secret) serves session+user without the D1 `session`+`users`
reads, hard-expires after `maxAge`, and transparently falls back to the database
on miss/expiry. No secondary storage is configured (D1 only), so
[better-auth#4203](https://github.com/better-auth/better-auth/issues/4203)
(`secondaryStorage` without `storeSessionInDatabase`: the DB session row was
never written → logout after `maxAge`) cannot apply. Tradeoff: session validity
(revocation) can be stale for up to `maxAge` — the middleware does not re-check
the session row. Role-based authorization is not stale: the API middleware
re-reads `users.role` from D1 on every session-authenticated request (a missing
row or failed lookup denies → 401), so a demoted superadmin loses admin access
immediately. cookieCache staleness therefore applies to session validity and to
session-payload fields, not to role-based authorization.

### Webhooks — maps natively

Raw-body-before-parse (`request.arrayBuffer()`), HMAC-SHA-256 via WebCrypto
`crypto.subtle` — no Node crypto. `ctx.waitUntil` extends execution up to 30s after
the response (GitHub times out deliveries at 10s — ample). CPU cost of HMAC + few D1
writes is ms-scale. Post-ack atomic work must fit `batch()` (see above).

### Env/secrets/filesystem

- Secrets via `wrangler secret put`; injected per-request.
- Jev (System 1 advisory layer) has no filesystem or Workers-binding dependency,
  but its configuration is no longer env: the base URL, model, enabled flag, and
  the envelope-encrypted API key live in the D1 registry
  (`assistant_jev_config` / `assistant_jev_secrets` / `assistant_jev_projects`),
  configured in the webapp (Admin → Assistant → Providers & Models). With no key
  stored and the flag off the layer stays disabled and costs nothing. It uses the
  same `LXK_SECRETS_MASTER_KEY` as every other managed secret.
- GitHub config lives in D1 via the web app — no GitHub secrets.
- **Managed secrets** (MCP client tokens, LLM provider API keys, and the Jev API
  key entered in the webapp) work natively here — which is the point, since
  Workers has no per-client auth path other than a bound secret. The managed
  secret is the **only** credential source: the `env:`/`file:` reference mode was
  removed on 2026-09-28. Both envelope keys are ordinary Workers secrets:
  ```bash
  wrangler secret put LXK_SECRETS_MASTER_KEY        # base64 of exactly 32 bytes
  wrangler secret put LXK_SECRETS_MASTER_KEY_PREV   # optional: rotation read path only
  ```
  `LXK_SECRETS_MASTER_KEY` is **required to store a managed secret**: with no key
  bound, an MCP save carrying a token is refused with
  `MCP_INVALID_TRANSPORT_CONFIG` and a provider/Jev save carrying a key with
  `SECRET_KEY_UNAVAILABLE`, while a secret-less client (no token at all) remains
  legal and a keyless provider still works. An already-stored secret is **never
  silently dropped** — it keeps `hasSecret`/`hasKey` true and hard-fails until
  the key is restored or the secret is cleared (a provider/MCP open failure maps
  to `PROVIDER_AUTH_FAILED` / `MCP_CONNECT_FAILED`; Jev just fails open).
  Clearing needs no key (`clearSecret`/`clearKey` is a pure row delete, so a
  credential can always be revoked even on a key-less deployment). See
  `docs/DEPLOYMENT.md` (variable reference, rotation) and
  `docs/BACKUPS.md` (the key must never be co-located with D1 exports).
  - **Provider backfill on Workers.** There is no boot phase, so the one-way
    plaintext-key backfill (`server/db/provider-secrets-backfill.ts`) runs on the
    per-isolate **first request** inside `ensureBoot`, after the DB config sync;
    concurrent cold starts share one boot promise and re-running is a no-op. With
    no master key bound, nothing is written and the blocked count is logged.
  - **Crypto parity caveat:** encryption is AES-256-GCM through
    `crypto.subtle` with a 12-byte IV and a 128-bit tag, chosen because it is
    the only AEAD both Bun and workerd expose (XChaCha20/ChaCha20 are absent on
    workerd, and no new WASM dependency is wanted). A blob written by the Bun
    host is therefore readable by the Worker **and vice versa** — same key, same
    layout — which is what lets a deployment be moved between flavors without
    re-entering secrets. The subtlety is the *parameter* contract, not the
    primitive: `additionalData` binds each blob to its scope and owner id (the
    client id / provider id / Jev config id), the tag length
    is fixed at 128 bits, and the IV must be a fresh 12 random bytes per write.
    Any divergence in those three details silently yields the one fixed
    "could not be decrypted" error (a hard failure for MCP/provider, fail-open
    for Jev), never an anonymous connect. `key_id` records only the keyring
    **slot** (`active`/`prev`) — never a fingerprint — so rotation reads through
    `LXK_SECRETS_MASTER_KEY_PREV` with no rewrap.
- Migrations: `wrangler d1 migrations create/apply`; seed via
  `wrangler d1 execute --file`. Replaces `scripts/dev.sh` boot + `seed-dev.sql`.
  Migration `0012_remove_mcp_secret_refs.sql` (a single `UPDATE` clearing the
  legacy `secret_ref` column) must be applied **with or before** the build that
  removes reference mode: reference resolution is gone in code, so an
  un-migrated row with a stored ref refuses to connect with a hard
  `MCP_CONNECT_FAILED` (never an anonymous connect) until it is cleared — the
  migration clears every row, and any write to a client nulls its ref too.
- cloudflared tunnel dropped entirely — Worker custom domain replaces it; the
  old `lexa-cli deploy` flow is gone (removed in cli-v2026.2.0).
- The AI path runs on Workers-only `@cloudflare/ai-chat` `AIChatAgent` Durable
  Objects (ADR-0003; the pre-ADR in-process SSE transport is retired and the
  agent-runtime tier is removed, so the assistant does not exist on Bun) —
  no external runner to host; outbound subrequest budget 50/request free, 1000 paid.

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

> This section is **superseded by ADR-0003** (accepted 2026-10-01): the assistant on this flavor
> is `@cloudflare/ai-chat` `AIChatAgent` Durable Objects (one DO per conversation
> thread, WebSocket transport, DO SQLite canonical + D1 `assistant_threads`
> mirror), and the Bun flavor ships without the assistant. The TanStack AI
> tier described below is the pre-ADR state and is transcribed in a later phase.

Current state (Aug 2026): `@tanstack/ai` 0.47.x, MIT, still 0.x (~24 minors in 3
months; one wire-format break already shipped). Core is web-standard JS — workerd-
clean. Official `@cloudflare/tanstack-ai` 0.2.1 exists (Workers AI binding + AI
Gateway routing; published from `cloudflare/ai`, not the TanStack monorepo).

Decision (2026-08-22, amended 2026-09-26; execution model superseded by ADR-0003):
the `chat()` path IS the only AI tier — **Assistant** (writing assistant + PM
assistant), now Workers-only `AIChatAgent` Durable Objects (one DO per thread)
instead of the pre-ADR in-process engine. The daemon/opencode
coding tier was removed end to end on 2026-09-26 (see `docs/ARCHITECTURE.md`
§Assistant → removal record); there is no external runner, no claim loop, and
nothing Workers-hostile left in the AI path. See `docs/ARCHITECTURE.md` §Assistant.

Shape:

```
POST /api/assistant/tasks → queue → server-side chat():
  adapter       = openaiCompatible | anthropic — custom baseUrl + apiKey from
                  settings (both verified custom-endpoint-capable; OpenRouter is
                  only an example endpoint)
  systemPrompts = [agentMarkdown, skillMarkdown, taskContext]  // verified option;
                  // {content, metadata} form carries Anthropic cache_control
  tools         = toolDefinition().server(fn) — web_search/fetch_url (SSRF-guarded),
                  get_task/search_tasks reads; PM memory injected as a prompt
                  block (read-only) — PM writes deferred, no approval gate shipped
  middleware    = withPersistence → assistant_threads (ModelMessage[] JSON)
→ SSE stream back (RUN_STARTED → TEXT_MESSAGE_CONTENT* → RUN_FINISHED | RUN_ERROR)
```

- Task/wiki context injected read-only via existing `shared/markdown.ts`
  (TipTap→markdown). Middleware hooks mutate prompts/model per request;
  `ctx.defer()` for post-stream DB writes; AbortController cancels on client
  disconnect.
- Rules/skills: `lexa_agents`/`lexa_skills` schema feeds prompt injection on this
  path (the only renderer — the `.agents/` file-writing renderer is gone with the
  daemon tier). Skills may additionally declare tool bundles bound per call.
- Memory = three layers: Lexa DB via read tools (live truth, never memorized);
  thread transcripts (`withPersistence`, driver-agnostic store — bun:sqlite now,
  D1 later); curated `project_memory` FTS5 table for judgment-type facts only.
  Long threads roll into summary rows (explicit replacement for opencode's
  auto-compaction).
- Gotchas: terminal failure arrives as a `RUN_ERROR` event inside the stream, not a
  throw — the SSE bridge must translate it. Every loop iteration (provider call +
  tool subrequests) draws from the Worker subrequest budget (50 free / 1000 paid
  per request) — `maxIterations` + repo caps double as budget guards.
- Capability: repo/source reads covered (pre-fetch today, agentic
  `read_repo_file`-style tools when wanted); PM reads via injected memory
  block + task tools. Not covered, and deliberately so: shell/file-edit/exec and
  sandbox filesystem work — coding territory, removed with the agent-runtime tier
  (reintroducing it needs a new architecture decision + security review).
- **Verdict: one Assistant tier, Workers-only DO execution** (`AIChatAgent`
  `LexaAssistantAgent`, ADR-0003), no daemon path. Services
  `Lexa/AssistantChatService` / `Lexa/AssistantTaskService` behind the
  `Lexa/Assistant` facade.
- Churn risk: pin exact versions and wrap `chat()` behind the `Lexa/Assistant`
  service boundary so SDK swaps stay contained.

## Assistant harness on Workers (ADR-0004)

The assistant is a Workers-only Durable Object runtime (`LexaAssistantAgent`,
ADR-0003). The harness layer on top (ADR-0004) keeps secrets Worker-side and
gives the DO a per-turn context bundle:

- **Turn context.** Each turn makes one internal `POST
  /api/internal/assistant/turn-context` (signed `X-Lexa-Internal` identity;
  body `{ threadKey, runId?, userText, mode }`) and receives agent
  instructions, ≤3 `$skill` markdowns + catalog, the memory block, doc/mention/
  repo context, the Jev advisory, the thread summary, tool descriptors, and
  boolean flags. No key or allowlist value crosses to the DO; provider config
  stays a separate `GET provider-config` read.
- **Runs + schedules.** Delegated runs are facet children of the thread DO; D1
  `assistant_runs` is the durable registry and `assistant_schedules` is drained
  by the existing `*/15` `scheduled` handler (migrations `0020`/`0021`). The
  registry surfaces through `GET /api/admin/assistant/runs`; schedules have
  per-project CRUD routes.
- **`workers_ai` models (H9).** A model row with kind `workers_ai` builds
  `createWorkersAI({ binding: env.AI })` for keyless Workers AI inference
  instead of a REST provider; ids are entered manually because the binding has
  no listing route. `wrangler.jsonc` declares `"ai": { "binding": "AI" }` and
  `scripts/workers-install.ts` (`resolveAiBinding`, wired into the generated
  per-deploy config) transcribes it — an absent block is omitted, a malformed
  one or a non-`AI` binding name is refused loudly. The staging example carries
  the same block. `ai` is remote-only by design (no local simulator), so local
  `dev:workers` needs a Cloudflare credential (`CLOUDFLARE_API_TOKEN`, or an
  interactive `wrangler login`) for the plugin's remote-bindings proxy; the
  release build disables remote bindings (`vite.config.ts` gates
  `remoteBindings: false` to the build/preview pass), so it needs no token and
  still ships the `ai` binding from the root config.
- **Call-log attribution.** `assistant_call_logs` gains `thread_key`, `run_id`,
  and `purpose` (`turn|runner|preflight|summary`, default `turn`); cost is
  computed from the imported CF per-token prices when the caller sends none.

**Tracing (sampling/cost).** `server/assistant/tracing.ts` wraps the `ai`
namespace with `wrapAISDK()` (`agents/observability/ai`) and passes
`functionId: lexa-assistant` plus `agentId`/`conversationId`/`runId`/`purpose`
as runtime context, so a turn emits `invoke_agent → chat → execute_tool →
tool_approval` spans to the CF Agents dashboard. Payload storage is OFF
(`storeMessages`/`storeTools` default false) — traces are metadata-only.
`wrangler.jsonc` enables observability with `head_sampling_rate: 1` (traces and
logs persist, 7-day retention) and the installer transcribes that block.
Workers Observability is billed from 2026-12-01, so the trace surface is
deliberately the 7-day debug view, not the product metric: token/cost
accounting remains Lexa's own (`assistant_model_prices` →
`assistant_call_logs.cost_cents`, `GET /api/projects/:slug/assistant/usage`).
Per-turn cost is recorded independently of tracing, so lowering
`head_sampling_rate` to cut the trace bill never blanks the cost view.

## Upgrading a Workers deployment (`lx worker upgrade`)

`lx worker upgrade` updates a self-hosted Workers deployment in place: it
fetches and sha256-verifies the release bundle, preserves the prior deploy's
bindings and custody, applies pending D1 migrations, redeploys, and rolls the
deploy dir back on failure. It is the CLI counterpart to re-running
`install.sh`; both are supported. `install.sh` stays the whole upgrade for a
fresh-machine re-run (see `docs/DEPLOYMENT.md` §Upgrade), while
`lx worker upgrade` updates an existing custody dir from the headless CLI.

**Two different updates.** `lx upgrade` is **CLI self-update** — it replaces the
`lx` binary from the newest `cli-v*` release asset. `lx worker upgrade` is the
**web app** on Cloudflare Workers. CLI releases (`cli-vX.Y.Z`) and web-app
releases (`vX.Y.Z`) are independent tags.

### Keep the custody dir

Run the update from the custody dir (`cf-workers/` by default) — **do not
delete it**; a re-run then has no prior bindings to preserve and no saved
credentials. It holds:

- `cf-workers/deploy-<flavor>/wrangler.<flavor>.json` — the per-deploy config
  (account, D1/R2/KV ids, vars, Durable Objects). The rebuild preserves these
  bindings verbatim — the ids identify **live** resources and are never
  recreated.
- `cf-workers/deploy-<flavor>.bak` — the prior bundle backup (the rollback source).
- `cf-workers/.cf-token` — the saved Cloudflare API token (0600).
- `cf-workers/.env.toml` — `LXK_SECRETS_MASTER_KEY` custody (0600); a missing
  key is a warning, not a refusal.

### Run it

```bash
cd cf-workers && lx worker upgrade
# or point at the dir from anywhere:
lx worker upgrade --dir /path/to/cf-workers
```

The default dir is the CWD; `--dir <path>` overrides it. If several
`deploy-*` dirs exist, pass `--worker <name>` (matches the deploy flavor or the
worker name); with exactly one deploy it is selected, otherwise a saved login
host matching `vars.LXK_PUBLIC_URL` breaks the tie, and anything else is
refused as ambiguous. When a saved login exists, the deploy's host is
cross-checked against `LXK_PUBLIC_URL` before anything runs.

| Flag | Behavior |
|---|---|
| `--dir <cf-workers>` | custody dir (default: CWD) |
| `--worker <name>` | pick a deploy when several exist (flavor or worker name) |
| `--cf-token <tok>` | Cloudflare API token, highest-priority credential |
| `--version <tag>` | pin the release tag (`v2026.6.2` or `2026.6.2`) instead of the newest |
| `--dry-run` | resolve + verify + print the plan, make no changes |
| `--yes` | skip the confirmation prompt |
| `--force` | reinstall even when already at the latest version |

`--dry-run`/`--yes`/`--force` are presence checks — `--dry-run extra` still
counts as a dry run. A bare value flag (`--dir` with no value, or `--dir=`) is
a usage error. Without `--yes` the run prompts; a non-TTY run aborts.

### Credentials chain

First match wins; the token is never printed:

1. `--cf-token <tok>`
2. `CF_API_TOKEN`
3. `CLOUDFLARE_API_TOKEN`
4. `<dir>/.cf-token`
5. `<deployDir>/.cf-token`

A non-dry-run update with no credentials fails with guidance; `--dry-run`
returns before the token check, so it needs none. `LXK_UPGRADE_OFFLINE=1` (or
`true`) forces the release/migration seams to fail fast for an offline dry run.

### Version compare

- **Current** is `vars.LXK_VERSION` from the deploy config; a config predating
  the marker reads as `unknown` (a warning, not a failure).
- **Latest** comes from the release resolver: it lists releases and anchors on
  the newest `v[0-9]` tag, so `cli-v*` tags never match and GitHub's
  `releases/latest` is never used. The tarball is sha256-verified against
  `checksums.txt`.
- If current equals latest the command refuses; `--force` reinstalls the same
  version.

### Safety: backup, rollback, migrations

- Before any mutation the deploy dir is copied to `deploy-<flavor>.bak`
  (replacing an older backup). On a failed deploy the dir is restored from it
  via a temp sibling + rename, so a crash mid-copy never leaves the deploy dir
  missing. The `.bak` is retained.
- **Rollback restores the deploy dir only — applied D1 migrations are NOT
  reverted.** A failed deploy after migrations applied leaves the schema
  forward; the report says so explicitly.
- Migrations run as a pre-flight: the pending set is the `.sql` files not in the
  live D1 `_migrations` journal, sorted for deterministic order. A journal gap
  (a pending file sorting before an already-applied one) is refused — applying
  a lagging file later would run its statements after later DDL.
  `0012_remove_mcp_secret_refs.sql` (`MCP_SECRET_REFS_MIGRATION`) is
  load-bearing: it must be applied with or before the managed-only build, so
  the refusal names that rule. Pending migrations are applied **before**
  deploy.
- A non-dry-run pre-flight that cannot read the journal fails the update; a dry
  run logs `Migrations: unavailable` and continues.

A dry run prints `Release`, `Latest` (with current), `Checksum`, and
`Migrations` lines and exits 0.

## Top risks

1. **Sync→async DB rewrite + transaction semantics (L).** Every repo/service
   signature changes; emission invariant and webhook atomic move+synced-state are
   pre-computed `batch()` statement arrays. Read-dependent sites are either folded
   into the batch SQL or carry an explicit read-compute-retry window.
2. **Effect runtime lifecycle on workerd.** Lazy layer-build hang (#6319) wedges
   isolates; per-request bindings vs module-scope Layers forces architecture change.
   Mitigation: eager module-scope runtime build, pinned Effect versions.
3. **D1 single-writer throughput + 30s batch ceiling.** Sequential execution queues
   under concurrency; kanban drag storms could hit overload errors. Load test before
   committing.
4. **TanStack AI 0.x churn** — superseded by ADR-0003 (the assistant moves to
   `@cloudflare/ai-chat` Durable Objects, which retires this risk).
5. **Assistant capability scope** — the coding tier (shell, file edits, sandboxes)
   is gone by design; users expecting a coding agent get an explicit explanation
   rather than a degraded mode.

## Bottom line

Migration buys ops simplicity (no VPS process, no tunnel, simple deploys) and $5/mo
flat infra — not capability. The current Bun+tunnel design is already sound. The real
price is the L-effort async persistence rewrite plus re-expressing the atomicity
invariants as D1 batches. If pursued, first step: a D1 driver abstraction behind the
repo layer (`@effect/sql-d1` exists upstream) that keeps the Bun host working while
making a Workers deployment possible later.

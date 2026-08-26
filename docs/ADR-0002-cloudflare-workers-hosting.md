# ADR-0002: Cloudflare Workers hosting — parallel flavor alongside Bun+Docker

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related research:** `docs/CLOUDFLARE_WORKERS.md` (now design authority for the Workers flavor)

## Context

Lexa currently runs as a single production flavor: Bun standalone + SQLite WAL +
cloudflared tunnel, deployed via `lexa-cli deploy <domain> prod` which provisions
a Docker image + tunnel + DNS (see `docs/DEPLOYMENT.md`). The design is sound and
the live system stays on it.

A second hosting target — Cloudflare Workers + D1 + R2 — is now viable per the
research note `docs/CLOUDFLARE_WORKERS.md` (2026-08-22). It buys $5/mo flat
infra, no VPS process, no tunnel, git-push-style deploys. The price is a real
migration: bun:sqlite → D1 (sync→async), re-expression of the two atomicity
invariants as D1 `batch()` arrays, per-request env + auth factory, R2 binding
driver, `@cloudflare/vite-plugin` SSR. Research calls this L-effort.

## Decision

Add a second, fully independent hosting flavor — **Workers + D1 + R2** — that
coexists with the existing Bun+Docker flavor. The two flavors are peer-level;
neither replaces the other; either or both can be live at any time.

1. **Runtime split:** two flavors, separate users. Each flavor has its own
   domain, DB, attachment bucket, settings, and lifecycle. Same source tree
   builds both via a Vite plugin chain that emits two server bundles
   (Bun entry + Workers entry).
2. **Data layer:** one repo, two drivers. `server/db/drivers/bun-sqlite.ts` and
   `server/db/drivers/d1.ts` both implement `DbDriver`. Repos are async; the
   `bun-sqlite` driver wraps the sync API in `Promise.resolve`, so the existing
   code-shape is preserved.
3. **Atomicity invariants re-expressed:** the emission invariant
   (mutation + `task_activity` in one atomic unit) and the webhook atomic move
   + `github_synced_state` write become pre-computed `{ sql, params }[]`
   arrays passed to `db.batch()`. The WIP-limit conditional UPDATE stays a
   single statement. Read-modify-write sites that aren't strict emissions stay
   as-is.
4. **Env access:** `server/env.ts` returns a `RuntimeEnv` — `process.env` on
   Bun, `env` from `cloudflare:workers` on Workers. Every module-scope
   `process.env.X` read goes through this helper. `server/auth.ts` becomes
   `createAuth(env)`, a per-request factory.
5. **Storage:** Workers uses the R2 native binding (driver kind `"r2"`); Bun
   keeps `fs` and `s3` (S3 covers R2's S3 endpoint for Bun-side users). The
   `StorageDriver` interface is unchanged.
6. **No data sync between flavors.** A user who wants to move from Bun to
   Workers dumps the Bun DB to SQL and replays it on D1 manually.
   `lexa-cli deploy workers --seed` re-applies the dev seed file.
7. **Deploy surface:** `lexa-cli deploy <domain> [bun|workers] [staging|prod]`
   is the operator's pick point. The Bun flavor uses the existing
   Docker+cloudflared flow. The Workers flavor provisions D1+R2+KV+Worker route
   via the Cloudflare API and ships a prebuilt bundle.
8. **Cron + observability:** Workers' `scheduled` handler runs prune + backup
   (cron `*/15 * * * *`); `wrangler.jsonc` enables observability. The Bun path
   keeps its `setInterval`.
9. **Compliance gate:** a new `scripts/check-invariants.ts` scans the source
   tree for the 14 architectural invariants listed in `AGENTS.md` and fails any
   PR that introduces a violation. This is the durable record of the invariants
   for future contributors.

## Alternatives considered

- **Status quo (Bun only):** rejected — the research note shows Workers is
  feasible and the cost is a one-time L-effort migration. The current design
  is sound but locks every deployment to a VPS.
- **Workers as the only flavor (cutover):** rejected — too risky for a live
  system. The user wants both options live; cutover is a separate decision.
- **Workers as primary, Bun as warm backup (single-domain):** rejected — the
  user wants two independent flavors, not a fail-over pair. Different problem.
- **D1 canonical + sqlite read-mirror:** rejected — needs a sync tool and
  changes the dev flow (`bun run dev:full` would have to talk to D1). Out of
  scope for this decision; documented as a follow-up possibility.
- **One-way export (D1 → sqlite) for fallback:** rejected — adds a sync tool
  the operator has to maintain for a capability not asked for.
- **TanStack Start on Bun only (no Workers):** rejected — the
  `@cloudflare/vite-plugin` is the official partner path; using Start on Bun
  with `cloudflare:workers` polyfills would be a third unsupported surface.

## Consequences

**Positive**

- Two independent deploy surfaces. The user picks per-domain; either can be
  live; one failing does not affect the other.
- $5/mo flat infra is available for users who don't want to run a VPS.
- The repo layer is async + driver-shaped. Future DB backends (Postgres,
  Turso, libSQL) slot in as new `server/db/drivers/*.ts` files.
- The invariant compliance script is a durable guard rail. Future contributors
  see the 14 invariants enforced at PR time.
- The R2 binding driver + aws4fetch presign pattern is contained to
  `server/storage/`. Swapping object storage later is a single-file change.
- Workers is the first edge deploy; subsequent edge targets (Vercel, Netlify)
  reuse the same `DbDriver` shape.

**Negative / accepted risks**

- D1 has no interactive transactions. Every multi-statement atomicity site
  re-expresses as a pre-computed `batch()`. Service-to-service interleaved
  reads are forbidden. (Mitigation: phase 5's inventory gate + the compliance
  script.)
- D1 sequential query execution + 30s batch ceiling. Kanban drag-storms could
  hit overload errors. (Mitigation: not load-tested by this plan; if real
  users hit it, fall back to the Bun flavor or build a per-project write
  queue. Both are follow-up plans.)
- TanStack AI 0.x + Effect 3.x + `@cloudflare/vite-plugin` are all on
  pre-1.0 versions or recent majors. Version pins are exact; SDK swaps are
  contained to one service each. (Mitigation: research note §Risks.)
- Two flavors means two deploy surfaces to maintain. The CLI's
  `runtime: "bun" | "workers"` is the single dispatch point; the docs
  (`DEPLOYMENT.md`) explain both.
- The compliance script is regex over source, not AST. False positives are
  accepted; missed violations are the failure mode. (Mitigation: the
  inventory in phase 5 is the human review gate.)
- `lastInsertRowid` is not reliable on D1. Every caller that needs the rowid
  adapts to `RETURNING` or a second read. (Mitigation: phase 4 + the
  compliance script flag any `lastInsertRowid` reference outside Bun.)
- The `createAuth(env)` factory + `createApiHandler({ driver, env, ... })`
  signature change is a parameter-only refactor, but it's a wide one
  (every API route + every auth call site touches the new shape). The Bun
  path's behavior is byte-identical; the tests guard this.

## Compliance notes

- **#1 No service-to-service cycles.** Preserved. The new `createAuth(env)` is
  a factory, not a service; the new `createApiHandler` accepts primitives.
  No new edges between services.
- **#2 Echo suppression.** Preserved. The webhook move + `github_synced_state`
  write are inside one `db.batch()` on the Workers path, one `withTx` on the
  Bun path. The compliance script grep-checks both call sites.
- **#3 Webhook atomic.** Preserved. The webhook route still has
  `bypassGuards: true`; the move + synced-state write are in one batch. The
  Workers `scheduled` handler does NOT touch the webhook path.
- **#4 Positions deterministic.** Preserved. The read-anchor-then-generate
  pattern is unchanged; `isPositionConflict` retry-once maps cleanly to D1
  (a single-statement UPDATE that may fail with a constraint violation).
- **#5 WIP limit atomic.** Preserved. The conditional UPDATE is one
  statement. It does not need `batch()`.
- **#6 Mutation cache consistency.** Preserved. The frontend
  `setQueryData`-on-mutation pattern is unchanged; the Workers path serves
  the same REST responses the TanStack Query hooks consume.
- **#7 Markdown at the boundary.** Preserved. `shared/markdown.ts` is the
  only markdown conversion site. The new R2 presign helper (if added in
  phase 1) lives in `server/storage/`, not the client.
- **#8 Webhook auth = signature.** Preserved. The webhook route has no
  API-key middleware; HMAC-SHA-256 over the raw body is the auth. The
  `createWebhookVerifier(driver)` factory accepts a `DbDriver` so the
  signature check is identical on both flavors.
- **#9 Column→GitHub state via `columns.github_state`.** Preserved. No code
  reads `column.name` to map to a GitHub state.
- **#10 Required fields enforced.** Preserved. The TipTap-aware emptiness
  helper runs on create/move/update. The D1 driver executes the same SQL.
- **#11 One-way link integrity.** Preserved. The `task_github_issues` PK
  + `UNIQUE(issue_id)` + per-repo ALREADY_LINKED guard are all SQL; D1
  supports them.
- **#12 Emission invariant.** Preserved. The `updateAndEmit` repo methods
  return pre-computed `batch()` arrays; on Bun, the same method body runs
  inside `withTx`. The compliance script grep-checks that every task
  mutation path goes through an `*AndEmit` method.
- **#13 Ticket keys immutable.** Preserved. `projects.key` + `tasks.number`
  are written once at create; no UPDATE statements touch `tasks.number`.
  The compliance script flags any `UPDATE tasks` that includes `number=`.
- **#14 Milestone/sprint rules.** Preserved. `HAS_CHILDREN` guard,
  `ON DELETE SET NULL`, archive cascade — all SQL; the
  `milestoneRepo.archiveAndEmit` cascade returns one batch array on D1,
  one withTx on Bun.

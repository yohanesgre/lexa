# Lexa — Agent Rules

You are working on **Lexa**: a self-hosted project management tool for a small game dev team (2–5 people). Kanban with swimlanes/WIP limits, tasks with rich descriptions, nested wiki, an MCP server so AI agents (Hermes/OpenCode) can manage tasks, and two-way GitHub issue sync. Single Cloudflare Worker + D1. Stack: TanStack Start + React + Effect-TS + Tailwind.

**This project was fully designed before implementation. Your job is to execute the design, not to design.**

## Document authority (read in this order before touching code)

1. `IMPLEMENTATION.md` — your execution plan. Phases, files, acceptance checks.
2. `SCHEMA.md` — SQL and data invariants. Copy verbatim.
3. `LAYERS.md` — Effect service patterns, error catalog, webhook/auth flows.
4. `API.md` — REST contract. Endpoint shapes are exact.
5. `MCP.md` — Agent-facing tool contract. Tool shapes are exact.
6. `DESIGN_SYSTEM.md` + `wireframes/` — all visual decisions.
7. `ARCHITECTURE.md` — context and rationale (decisions log) only.
8. `REVIEW.md` — historical record of design review. Do not implement from it.

**If documents conflict, stop and report the conflict to the user. Never resolve it yourself.**

## Non-negotiable rules

1. **No scope creep.** If a feature, table, column, endpoint, MCP tool, or error code is not in the design docs, it does not get built. If you believe something is missing, report it — don't add it.
2. **Names are exact.** Table names, column names, error codes, route paths, tool names, and config keys must match the docs verbatim.
3. **Phase gates.** Complete a phase's acceptance checks (paste outputs) before starting the next phase. `tsc --noEmit` must pass at every gate.
4. **No commits** unless the user explicitly asks.
5. **No comments** in code unless behavior is genuinely non-obvious.
6. TypeScript strict. No `any` outside JSON-payload boundaries (cast at the boundary).
7. If a named package/API differs in the installed version, adapt minimally and **declare the deviation in your reply**. Never silently substitute architecture.

## Architectural invariants — never violate these

These were each hard-won design fixes (see REVIEW.md). Breaking any of them reintroduces a known bug:

1. **No service-to-service cycles.** `TaskService` must never depend on `GitHubService`. Lexa→GitHub sync is orchestrated by route handlers only.
2. **Echo suppression.** Every Lexa→GitHub state sync writes `github_synced_state`; the webhook skips payloads matching it. Webhook delivery is recorded **after** successful processing, never before.
3. **Webhook moves bypass guards** (`bypassGuards: true`) and run as one D1 `batch()` (move + synced-state write). Webhook acks 200 immediately, processes in `waitUntil`.
4. **Positions are fractional-index keys.** Generation is deterministic — retries must re-read anchors before regenerating. Neighborless moves append to end; never `generateKeyBetween(null, null)` into a non-empty column. Retry only on `isPositionConflict`, at most once.
5. **WIP limit is enforced inside the conditional UPDATE** (atomic), with the within-column-reorder short-circuit (`column_id = ?2 OR count < limit`).
6. **Mutation responses are authoritative.** Frontend updates TanStack Query cache via `setQueryData` from the mutation response. Never `invalidateQueries` on the mutation path (D1 is read-replicated).
7. **MCP boundary speaks Markdown; REST boundary speaks TipTap JSON.** Conversion happens only in `shared/markdown.ts` and `server/mcp/`. Agents never see ProseMirror JSON; the frontend never sees Markdown.
8. **MCP takes names, not UUIDs** (columns/swimlanes by name, projects by slug). Failed lookups return `details.available*` with valid choices.
9. **Webhook route has no API-key middleware** — HMAC-SHA-256 signature verification over the raw body is the auth, and it runs before JSON parsing.
10. **Column→GitHub state mapping uses `columns.github_state`**, never column names.
11. **`required_fields` is enforced on create, move, AND update**, with TipTap-aware emptiness (a doc with no text nodes is empty).
12. **One task ↔ one GitHub issue** (`UNIQUE(github_issue_id)` + already-linked guard).

## Code conventions

- **Effect-TS everywhere on the backend.** Services/repos use `Effect.Service<Name>()("Lexa/Name", { effect: Effect.gen(...) })`. Domain errors are `Data.TaggedError`. Repos surface `RowNotFound | DbError | ConstraintViolation`; services map to domain errors per the catalog.
- **Repos are thin.** Raw D1 prepared statements via the helpers in `server/db/d1.ts`. No business logic in repos. `updated_at = datetime('now')` inside every UPDATE statement.
- **Routes are thinner.** `@effect/platform` HttpApi groups; parse → call service → return. Error→status mapping is declarative (`.addError`), from the catalog — no hand-rolled try/catch responses.
- **Frontend:** TanStack Query for all server state; components match `wireframes/*.html` structure and `DESIGN_SYSTEM.md` tokens exactly. PHOSPHOR tokens are CSS variables — no raw hex outside `phosphor.css`.
- **File placement:** `app/` (TanStack Start routes + components), `server/` (db/repos/services/api/mcp/github), `shared/` (types + pure functions). Nothing else at root except config.

## Verification commands

```bash
tsc --noEmit                    # must pass at every phase gate
vitest run                      # shared/ pure modules (markdown, positions)
wrangler dev                    # local smoke testing
wrangler d1 execute lexa-db --local --command "<sql>"   # inspect data
```

Each phase in IMPLEMENTATION.md has its own acceptance block — run it and paste the output.

## When you're stuck

1. Re-read the relevant design doc section — the answer is usually there.
2. Check `REVIEW.md` if you're tempted to change an invariant (it explains why it exists).
3. If genuinely blocked or docs are ambiguous: **stop and ask the user.** State what's ambiguous and what you would otherwise do. Do not guess on architecture.

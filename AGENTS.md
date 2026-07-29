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

## Wireframes are the frontend source of truth

The `wireframes/` directory contains the final UI/UX decisions for Lexa. When implementing or modifying frontend code, treat the wireframes as the authoritative reference for layout, structure, component states, and user flows. This section complements `IMPLEMENTATION.md`: the implementation plan defines the phase-by-phase build order and acceptance checks, while this rule defines how to interpret the wireframes when building frontend screens.

1. Start with `wireframes/flow-overview.html` to understand canonical user flows and project-context rules.
2. Use `wireframes/index.html` to browse all surfaces and states.
3. Match the structure, spacing, hierarchy, and interactions shown in the wireframes exactly.
4. Use `DESIGN_SYSTEM.md` for tokens, typography, and color values. PHOSPHOR tokens are CSS variables — no raw hex outside `phosphor.css`.
5. If a wireframe conflicts with `DESIGN_SYSTEM.md` or any other design doc, the wireframe wins for frontend implementation. Report the conflict to the user.
6. Do not add screens, states, or components that are not represented in the wireframes without explicit user approval.

The wireframes are static HTML/CSS previews with no JavaScript. Implement interactions (dropdowns, modals, slideovers, drag-and-drop, inline editing, etc.) to match the rendered states and annotations.

Wireframes use `<INCLUDE partials/FILE />` directives. Always run `bash wireframes/build.sh` after any wireframe edit. Edit source files in `wireframes/src/`, never edit built output in `wireframes/` directly.

### For @designer: wireframe-first execution

When asked to implement frontend, do NOT design or invent. Read the relevant wireframe HTML file, then transcribe what you see into React components. Copy layout, spacing, copy text, and hierarchy exactly. Do not add extra padding, borders, or visual treatments not present in the wireframe. If the wireframe shows 3 columns, build 3 columns. If it shows a toggle in the sidebar, build that toggle. No creative interpretation.

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

## Agent file boundaries

These rules are non-negotiable and apply to every agent working on Lexa:

- **@designer may only modify:**
  - `app/components/` (UI components)
  - `app/routes/` (route-level layout/styling, no backend logic)
  - `app/styles/` (CSS, design tokens)
  - `app/lib/` (client-side query hooks and utilities — never server libs)
  - `DESIGN_SYSTEM.md` and `wireframes/design-system.css`
- **@designer must never touch:**
  - `server/` (any backend code: repos, services, MCP, API, DB, GitHub)
  - `shared/types.ts` (schema types — read-only)
  - `shared/` except pure frontend utilities explicitly in scope
  - `IMPLEMENTATION.md`, `SCHEMA.md`, `LAYERS.md`, `API.md`, `MCP.md`, `ARCHITECTURE.md`, `REVIEW.md`
  - `package.json`, `tsconfig.json`, `wrangler.jsonc`, `app.config.ts`
- **@fixer scope is per-task** — specify exact files; same constraints apply unless the task explicitly includes backend files.
- If an agent discovers a need for a new backend endpoint or shared type, it must report back to the orchestrator — never add it itself.

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

## Agent-browser usage

When using agent-browser for testing, QA, or review, divide the scenario into smaller, focused tasks:

1. **Open the page and snapshot first** — confirm the page loaded before interacting.
2. **Test one feature at a time** — don't chain clicks across components in one pass.
3. **Prefer `find role|text button click --name "..."` over `@eN` ref clicks** — refs become stale after any DOM change; semantic locators are more reliable across re-renders.
4. **Verify after each interaction** — screenshot or snapshot after each click to confirm expected state.
5. **Close overlays before continuing** — modals/dropdowns/menus may block interactions with underlying elements.
6. **Check the console** (`eval` for `console.log` buffers) when a click produces no visible result.

### Testing wireframes

Wireframes are static HTML files with no JavaScript. To preview them with agent-browser:

```bash
# Start a Python HTTP server in the wireframes directory (always use nohup)
cd wireframes && nohup python3 -m http.server 8080 &

# Always start the server first before using agent-browser on wireframes
# The server must be running in the background

# Open the wireframe
agent-browser open http://localhost:8080/wiki-edit.html

# Inspect
agent-browser screenshot /tmp/wireframe.png
agent-browser snapshot -i -d 5

# Clean up when done
pkill -f "http.server 8080"
```

Use this to visually verify wireframe layout, spacing, and structure before implementing. Wireframe files live in `wireframes/` and use `wireframes/wireframes.css` for styles.

## When you're stuck

1. Re-read the relevant design doc section — the answer is usually there.
2. Check `REVIEW.md` if you're tempted to change an invariant (it explains why it exists).
3. If genuinely blocked or docs are ambiguous: **stop and ask the user.** State what's ambiguous and what you would otherwise do. Do not guess on architecture.

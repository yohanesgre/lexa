<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Precedence (this repo)

The harness combines global `~/.config/opencode/AGENTS.md` with this file
and resolves no conflicts automatically. Where they conflict on work inside
this repo, this file wins:
- A `/goal` execution-gate ack enumerating branch→commit→push→PR counts as
  the explicit ask for exactly those actions.
- Inside a `/goal` lane branch/worktree, the gate envelope is the explicit
  request for destructive ops.
- `.agents/skills/goal` roster IDs may be absent from the harness skill list;
  a failed load is a fallback signal, never a stall.
- `bunx` means `bun x` here; the rtk allowlist lacks herdr/opencode2, so raw
  shell is correct for those.
- Gate output tails in lane reports are code blocks: quote exact, exempt
  from compression.

## Git Workflow — single trunk (local auto-enforce)

Trunk `main` — never commit directly. Every task: `main` → new branch → work → PR → merge to `main`. Before any git mutation (branch/worktree, checkout -b, add, commit, push, merge/rebase/cherry-pick, tag `v*`/`cli-v*`, or `wireframes/` submodule) load `.agents/skills/git-workflow/SKILL.md` and follow guardrails verbatim. No commit/push/merge without explicit user ask; gate (`tsc --noEmit` + `vitest run` + `check:invariants` + secrets check) must be green. Quick gate: `bash .agents/skills/git-workflow/scripts/verify-gate.sh`.

You are working on **Lexa**: a self-hosted project management tool. Kanban with swimlanes/WIP limits, tasks with rich descriptions, nested wiki, and two-way GitHub issue sync. Bun server + SQLite database behind cloudflared tunnel. Stack: TanStack Start + React + Effect-TS + Tailwind.

## Status protocol + report contract

All work tracking uses one folder per plan under `status/` (the `work-plans` skill — the project ships one at `.agents/skills/work-plans/SKILL.md`; load it when opening, updating, or closing a plan):
- **Plan:** `status/<plan>/plan.md` — problem, scope, graph. Single source of requirements (read FIRST; the dispatch prompt is only context).
- **Status:** `status/<plan>/status.md` — `state: <PLAN|WAIT|WORKING|DONE|FAILED>` + `ts: <epoch>` + `msg: <message>`. Heartbeat on every significant action (fresh ts).
- **Lanes:** `status/<plan>/lanes/<lane>.md` — only when parallel tracks need separate heartbeats, same 3-line format. Plan-level status mirrors the slowest lane, never dumps lane logs.
- **Report:** `status/<plan>/report.md` — full report (what you did, tests with output, deviations, concerns). Reply in chat ONLY with: state, commit sha, one-line test summary, concerns (if any).
- **Timeline:** append one line per event to `status/TIMELINE.md` (`date | plan | state | one line | path`); link artifacts from memory (`mem_save` summary + paths) on DONE.
- **DONE** requires: gate green (where applicable) + tests + report file written + status file DONE. DONE does NOT mean reviewed — the orchestrator reviews after you.
- If blocked, write `state: WAIT` and stop; report the blocker instead of guessing.
- Never touch files outside your scope. If you need something outside it, report back — never add it yourself.
- No commits unless explicitly asked. Do not push. Do not merge.

## Document authority (read in this order before touching code)

0. `docs/design-system.html` — PHOSPHOR primitives: tokens + canonical component markup. **Before any UI work, open this file and copy primitive markup from it verbatim — never hand-write a primitive.** For primitive work it precedes the surface wireframes; for composite/surface work read it first, then the relevant `wireframes/src/*.html`.
1. `docs/SCHEMA.md` — SQL and data invariants. Copy verbatim.
2. `docs/LAYERS.md` — Effect service patterns, error catalog, webhook/auth flows.
3. `docs/API.md` — REST contract. Endpoint shapes are exact.
4. `wireframes/DESIGN_SYSTEM.md` + the wireframes submodule (`wireframes/`) — all visual decisions.
5. `docs/ARCHITECTURE.md` — context and rationale only.

**If documents conflict, stop and report the conflict to the user. Never resolve it yourself.**

## Design authority

Committed design authority lives in the top-level `docs/*.md` — SCHEMA
(SQL + data invariants), LAYERS (service patterns, error catalog), API (REST
contract), ARCHITECTURE (context + rationale). There is no private design area;
historical specs/plans were archived and removed.

## Wireframes are the frontend source of truth

**Wireframes are a git submodule** — `wireframes/` points at the separate PRIVATE repo `yohanesgre/lexa-wireframes` (see `.gitmodules`). **When working on frontend, ALWAYS ensure the submodule is present first** — before any frontend task, run:

```bash
git submodule update --init wireframes
```

This retains the wireframe-first flow on any clone: `wireframes/src/` is the design source of truth, `bash wireframes/build.sh` rebuilds the previews. If the submodule is missing or empty, frontend work must not start until it is initialized (and the gate that the wireframes reflect the change first still applies). All paths in this section are relative to this repo's `wireframes/` checkout.

**Wireframe-first rule (non-negotiable):** Any UI/UX design change — new states, layout changes, component changes, copy changes, motion changes — must be made in the wireframes FIRST (edit `wireframes/src/`, run `bash wireframes/build.sh`), then implemented in code. Never change the app's UI without the wireframes reflecting the change first. If code and wireframes drift, the wireframe is the source of truth.

**Delegation sequencing rule (non-negotiable):** When UI/UX work is divided across multiple agents, the wireframe lane MUST complete (edit `wireframes/src/`, run `bash wireframes/build.sh`, pass its gate) BEFORE any React implementation lane is dispatched. Never run wireframe work and frontend implementation in parallel — parallel lanes drift from the wireframe's actual classes, structure, and copy even when the spec looks fully pinned. React implementation transcribes the completed wireframe, including porting any new wireframe CSS classes into the app stylesheet (`app/styles/phosphor.css`) — wireframe classes do not exist in the app until ported.

Every UI task brief to @designer/@fixer must include: "Consult `docs/design-system.html` first; copy primitive markup verbatim."

**Annotation rule:** All notes, specs, behaviors, and design decisions inside wireframes use annotation notes — `<span class="annotation">` for inline element notes, `<span class="annotation-tag">` for behavior/spec tags. Never document wireframe decisions in plain HTML comments or invisible markup; notes must be visible in the rendered wireframe.

**Source vs compiled:** `wireframes/src/` is the wireframe source of truth — edit only there. `wireframes/dist/` is the compiled output (generated by `bash wireframes/build.sh`); never edit files in `wireframes/dist/` directly.

1. Start with `wireframes/src/flow-overview.html` to understand canonical user flows and project-context rules.
2. Use `wireframes/src/index.html` to browse all surfaces and states.
3. Match the structure, spacing, hierarchy, and interactions shown in the wireframes exactly.
4. Use `wireframes/DESIGN_SYSTEM.md` for tokens, typography, and color values. PHOSPHOR tokens are CSS variables — no raw hex outside `phosphor.css`.
5. If a wireframe conflicts with `wireframes/DESIGN_SYSTEM.md` or any other design doc, the wireframe wins for frontend implementation. Report the conflict to the user.
6. Do not add screens, states, or components that are not represented in the wireframes without explicit user approval.

The wireframes are static HTML/CSS previews with no JavaScript. Implement interactions (dropdowns, modals, slideovers, drag-and-drop, inline editing, etc.) to match the rendered states and annotations. Wireframes use `<INCLUDE partials/FILE />` directives — always run `bash wireframes/build.sh` after any wireframe edit.

### For @designer: wireframe-first execution

When asked to implement frontend, do NOT design or invent. Read the relevant wireframe HTML file, then transcribe what you see into React components. Copy layout, spacing, copy text, and hierarchy exactly. Do not add extra padding, borders, or visual treatments not present in the wireframe. If the wireframe shows 3 columns, build 3 columns. If it shows a toggle in the sidebar, build that toggle. No creative interpretation.

## Non-negotiable rules

1. **No scope creep.** If a feature, table, column, endpoint, or error code is not in the design docs, it does not get built. If you believe something is missing, report it — don't add it.
2. **Names are exact.** Table names, column names, error codes, route paths, tool names, and config keys must match the docs verbatim.
3. **Phase gates.** Complete a phase's acceptance checks (paste outputs) before starting the next phase. `tsc --noEmit` must pass at every gate.
4. **No commits** unless the user explicitly asks.
5. **No comments** in code unless behavior is genuinely non-obvious.
6. TypeScript strict. No `any` outside JSON-payload boundaries (cast at the boundary).
7. If a named package/API differs in the installed version, adapt minimally and **declare the deviation in your reply**. Never silently substitute architecture.

## Architectural invariants — never violate these

Each is a hard-won design fix; rationale lives in `docs/ARCHITECTURE.md` and the design notes in `docs/SCHEMA.md`. Breaking any reintroduces a known bug. See ARCHITECTURE.md for full rationale.

| # | Invariant | Why it matters |
|---|---|---|
| 1 | No service-to-service cycles. `TaskService` must never depend on `GitHubService`. | Lexa→GitHub sync is orchestrated by route handlers only. |
| 2 | Echo suppression. Every Lexa→GitHub state sync writes `github_synced_state`; webhook skips matching payloads. Webhook delivery recorded AFTER successful processing, never before. | Prevents feedback loops. |
| 3 | Webhook moves bypass guards (`bypassGuards: true`), run as one atomic transaction (move + synced-state write). Webhook acks 200 immediately, processes in `waitUntil`. | Atomicity + low latency. |
| 4 | Positions are fractional-index keys. Generation is deterministic — retries must re-read anchors before regenerating. Neighborless moves append to end; never `generateKeyBetween(null, null)` into a non-empty column. Retry only on `isPositionConflict`, at most once. | Stable ordering under concurrent reorders. |
| 5 | WIP limit enforced inside the conditional UPDATE (atomic), with within-column-reorder short-circuit (`column_id = ?2 OR count < limit`). | Race-free enforcement. |
| 6 | Mutation responses are authoritative. Frontend updates TanStack Query cache via `setQueryData` from the mutation response. Never `invalidateQueries` on the mutation path. | Cache consistency. |
| 7 | REST boundary speaks TipTap JSON. Markdown conversion lives only in `shared/markdown.ts` (used by GitHub sync, Hearth, CLI); the frontend never sees Markdown. | Single conversion surface. |
| 8 | Webhook route has no API-key middleware — HMAC-SHA-256 signature verification over the raw body is the auth, and it runs before JSON parsing. | Webhook auth is signature, not bearer. |
| 9 | Column→GitHub state mapping uses `columns.github_state`, never column names. | Decouples labels from identifiers. |
| 10 | `required_fields` enforced on create, move, AND update, with TipTap-aware emptiness (a doc with no text nodes is empty). | No silent bypass. |
| 11 | An issue links to at most one task; a task may hold several issues, one per repo (`task_github_issues` PK `(task_id, issue_id)` + `UNIQUE(issue_id)` + per-repo ALREADY_LINKED guard). | One-way link integrity. |
| 12 | Emission invariant. Every task mutation appends `task_activity` row(s) in the SAME transaction — one row per meaningful change (updates may emit several `field_changed` rows); position-only reorders emit nothing; webhook moves emit `github_synced` only. Messages come from the catalog (`server/activity-messages.ts`), frozen at write time — never hand-rolled at call sites. | Audit log + copy consistency. |
| 13 | Ticket keys are immutable. `projects.key` (prefix) + `tasks.number` written once at create, never reused. `PREFIX-n` accepted as task lookup alias everywhere a task id is. `projects.next_task_number` advances atomically; `UNIQUE(project_id, number)` index is the backstop, never a license to reuse. | Stable identifiers. |
| 14 | Milestone/sprint rules. A milestone with sprints can't be deleted (`HAS_CHILDREN`); deleting a milestone loosens its sprints (`ON DELETE SET NULL`), never cascades; archiving a milestone archives its sprints; exactly one Backlog per project (partial unique index), can't be archived or deleted. Sprint progress counts a task done when its column is a done column OR it is archived. | Backlog + sprint integrity. |

## Agent file boundaries

These rules are non-negotiable and apply to every agent working on Lexa:

- **@designer may only modify:**
  - `wireframes/src/**` and `wireframes/DESIGN_SYSTEM.md` (the wireframes submodule)
  - `docs/design-system.html` (PHOSPHOR primitives)
  - design tokens/specs as represented in the wireframes
- **@designer must never touch:**
  - `app/`, `server/`, `shared/`, `cli/` (all implementation belongs to @swe)
  - `package.json`, `tsconfig.json`, `app.config.ts`
- **@swe owns all implementation:** `app/components/`, `app/routes/`, `app/styles/`, `app/lib/`, `server/`, `shared/`, `cli/`. Implement UI from `wireframes/` verbatim; missing/drifted wireframes → report back for a designer pass, never invent UI.
- **@fixer scope is per-task** — specify exact files; same constraints apply unless the task explicitly includes backend files.
- If an agent discovers a need for a new backend endpoint or shared type, it must report back to the orchestrator — never add it itself.

## Code conventions

- **Effect-TS everywhere on the backend.** Services/repos use `Effect.Service<Name>()("Lexa/Name", { effect: Effect.gen(...) })`. Domain errors are `Data.TaggedError`. Repos surface `RowNotFound | DbError | ConstraintViolation`; services map to domain errors per the catalog.
- **Repos are thin.** Raw SQLite prepared statements via bun:sqlite. No business logic in repos. `updated_at = datetime('now')` inside every UPDATE statement.
- **Routes are thinner.** `@effect/platform` HttpApi groups; parse → call service → return. Error→status mapping is declarative (`.addError`), from the catalog — no hand-rolled try/catch responses.
- **Frontend:** TanStack Query for all server state; components match `wireframes/src/*.html` structure and `wireframes/DESIGN_SYSTEM.md` tokens exactly. PHOSPHOR tokens are CSS variables — no raw hex outside `phosphor.css`. Update cache via `setQueryData` from mutation responses only; never `invalidateQueries` on the mutation path.
- **File placement:** `app/` (TanStack Start routes + components), `server/` (db/repos/services/api/github), `shared/` (types + pure functions). Nothing else at root except config.

## Verification

```bash
tsc --noEmit                    # must pass at every phase gate
bun run dev                     # local smoke testing (vite + server)
```

Lane-scoped tests for iteration (pick your lane — `test`/`test:full` stay for pre-merge):

| Lane | Command | Scope |
|---|---|---|
| shared/pure | `bun run test:shared` | `shared/` (~150 tests, fastest) |
| backend | `bun run test:be` | `shared/` + `server/` incl. `server/api` |
| frontend | `bun run test:fe` | `shared/` + `app/` |
| cli | `bun run test:cli` | `cli/src/` |
| hearth | `bun run test:hearth` | `hearth/` + `shared/hearth-log` + `server/*hearth*` |

Full suite (`bun run test` / `test:full`) + `check:invariants` run only at the final gate / CI (PR runs `test:critical`, main runs `test:full` — see `.github/workflows/ci.yml`).

Acceptance checks live in `docs/GITHUB_SETUP.md` (sync round-trip) — run them and paste the output.

### Running the dev stack (Bun standalone, no Cloudflare)

The `.env` file is **required** — it supplies `LXK_API_KEY` (server auth).
`bun run setup` writes it (dev-only; self-hosters use the install script +
`/setup` wizard).

```bash
bun run setup          # first-time: admin email, API key, migrations, sample data
bun run dev:full       # API (:3000) + vite frontend (:5173) together, Ctrl-C stops both
# open http://localhost:5173
```

`scripts/dev.sh` (what `dev:full` runs) loads `.env` into the shell, boots
`server/entry.ts` on :3000 and `vite dev` on :5173 (vite proxies `/api` → :3000),
and sets `LXK_SEED_DEV=1` for sample data on every boot. Delete `data/lexa.db*`
to start fresh. DB lives at `data/lexa.db` (SQLite WAL). Health check:
`curl http://localhost:3000/api/health` → `{"ok":true}`.

Key facts:

- **vite auto-loads `.env`** — `VITE_*` flags land in `import.meta.env`
  automatically; no manual `set -a; . ./.env` needed for the frontend.
  Browsers authenticate via the session cookie — no key in the bundle.
- **Key rotation is safe:** browsers authenticate via the session cookie, so
  re-running `bun run setup` (which may rotate the key) never breaks the
  browser — no rebuild required.
- **`bun run dev:server` alone** serves the **built** app from `dist/` on :3000
  (frontend changes require `bun run build` first). Use it only for API work
  or to preview the production build; use `dev:full` for day-to-day development.
- **Setup wizard** (`scripts/setup-cli.ts` / web wizard `/setup`): prompts for
  admin email (`LXK_ADMIN_EMAILS`), keeps/generates `LXK_API_KEY`, runs
  migrations, seeds `scripts/seed-dev.sql` (only when the DB is empty). Sample
  data is **dev + staging**: the wizard seeds in `dev` and `staging`; any
  other `LXK_ENV` (prod) stays empty — the Backlog swimlane and default
  columns appear when a project is created. `/api/setup/*` endpoints are
  API-key exempt.
- **Human auth** is in-process Better Auth (email/password, cookie sessions
  at `/api/auth/*`) — no Cloudflare Access, no Google OAuth, no SMTP.
  Provisioning is admin-curated: `/setup` wizard creates the first superadmin;
  workspace invite links + set-password links onboard members. No public
  signup. See `docs/ARCHITECTURE.md` → Auth.
- **GitHub sync:** full setup guide in `docs/GITHUB_SETUP.md` — GitHub App
  creation, webhook URL/secret, `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` (inline
  PEM) or `GITHUB_PRIVATE_KEY_FILE` (path — recommended), prod volume mount.
  Webhook auth is HMAC-SHA-256 over the raw body — no Access bypass needed.

## Reference (read the linked doc/skill, don't inline it here)

- **Hearth (AI runtime):** `docs/HEARTH.md` — tier table, daemon/listener, run claim flow, warm opencode serve, persistent sandbox/workspace.
- **Releasing:** `docs/RELEASING.md` — version policy, pre-tag checklist, image flow, CLI build flow, deploy state.
- **lexa-cli operator tool:** the `lexa-cli` skill (auto-discovered; the
  project ships one at `~/.agents/skills/lexa-cli/SKILL.md`). Load it before
  any CLI work. lexa-cli is operate-only — no deploy commands (removed in
  cli-v2026.2.0; self-hosting goes through `scripts/install.sh`).
- **Browser automation:** the `agent-browser` skill (auto-discovered; at
  `~/.agents/skills/agent-browser/SKILL.md`). Load it before any browser
  work. If the active model lacks vision, the skill defaults to snapshot-
  first debugging (text-based accessibility tree, semantic locators) instead
  of screenshots.

## When you're stuck

1. Re-read the relevant design doc section — the answer is usually there.
2. If you're tempted to change an invariant, re-read its rationale in `docs/ARCHITECTURE.md` and the design notes in `docs/SCHEMA.md` (they explain why each exists).
3. If genuinely blocked or docs are ambiguous: **stop and ask the user.** State what's ambiguous and what you would otherwise do. Do not guess on architecture.

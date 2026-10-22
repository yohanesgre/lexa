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
- Generic skills — `goal`, `work-plans`, `git-workflow` — are global
  (`~/.agents/skills/`); this file's project rules win where they conflict.
- `bunx` means `bun x` here; the rtk allowlist lacks herdr/opencode2, so raw
  shell is correct for those.
- Gate output tails in lane reports are code blocks: quote exact, exempt
  from compression.

## Git Workflow — single trunk (local auto-enforce)

Trunk `main` — never commit directly. Every task: `main` → new branch → work → PR → merge to `main`. Before any git mutation (branch/worktree, checkout -b, add, commit, push, merge/rebase/cherry-pick, tag `v*`/`cli-v*`) load the `git-workflow` skill and follow guardrails verbatim. The owner's standing ask covers the whole lane: commit on the branch, push, open the PR, and enable **auto-merge** (`gh pr merge --auto --squash`) so it lands on `main` itself; do not stop to ask for a merge decision, and never commit directly to `main`. The gate (`tsc --noEmit` + `vitest run` + `check:invariants` + secrets check) must be green before the PR. Quick gate: `bash scripts/verify-gate.sh`.

You are working on **Lexa**: a self-hosted project management tool. Kanban with swimlanes/WIP limits, tasks with rich descriptions, nested wiki, and two-way GitHub issue sync. Bun server + SQLite database behind cloudflared tunnel. Stack: TanStack Start + React + Effect-TS + Tailwind.

## Status protocol + report contract

**`status/` is gitignored and never pushed** — it is ephemeral, machine-local orchestration state. Durable
outputs (rules, maps, contracts, rationale, decisions another device or clone must read) belong in `docs/`,
code comments, or `CHANGELOG.md`; a `status/` path must never be the only reference to something that
matters. Keep working artifacts there, promote the durable parts before closing.

All work tracking uses one folder per plan under `status/` (the global `work-plans` skill; load it when opening, updating, or closing a plan):
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

0. `DESIGN.md` (root) — the design system. Its token frontmatter is **normative** (the single token source — no second token list anywhere); its prose is how to apply them. `.impeccable/design.json` is the sidecar (tonal ramps, shadows, motion, breakpoints, component snippets, `themeOverrides` for the light theme). `PRODUCT.md` (root) is product truth. The operating procedure for UI/UX work is `.agents/skills/frontend-workflow/SKILL.md` — load it first.
1. `docs/design-system.html` — the canonical PHOSPHOR **primitive-markup reference**. **Before any UI work, open it and copy primitive markup verbatim — never hand-write a primitive.**
2. `docs/SCHEMA.md` — SQL and data invariants. Copy verbatim.
3. `docs/LAYERS.md` — Effect service patterns, error catalog, webhook/auth flows.
4. `docs/API.md` — REST contract. Endpoint shapes are exact.
5. `docs/ARCHITECTURE.md` — context and rationale only.

`docs/design-system.html` is a **frozen artifact**: the wireframes submodule that generated it was removed from this repo (2026-10-11, the design-system pivot), so it is no longer rebuilt. Copy primitive markup from it, but `DESIGN.md` + `.impeccable/design.json` are the living system.

**If documents conflict, stop and report the conflict to the user. Never resolve it yourself.**

## Design authority

Design authority is `DESIGN.md` (root) + `.impeccable/design.json` (the visual system), `PRODUCT.md` (root, product truth), and `docs/design-system.html` (canonical PHOSPHOR primitive markup). `DESIGN.md` is the single token source. PHOSPHOR tokens only — no raw hex outside `app/styles/phosphor.css`. Committed architectural authority stays in the top-level `docs/*.md` — SCHEMA (SQL + data invariants), LAYERS (service patterns, error catalog), API (REST contract), ARCHITECTURE (context + rationale). `wireframes/` is retired and is not a design source.

## Design system (Impeccable)

The design system is the authority; Impeccable (`.agents/skills/impeccable/`, engine launcher `.agents/skills/impeccable/scripts/impeccable`) is the design process; antislop is the quality filter. `DESIGN.md` (root) + `.impeccable/design.json` hold the tokens and the visual system — the frontmatter tokens are normative, the prose is how to apply them, and `DESIGN.md` is the single token source (no second token list anywhere). `PRODUCT.md` (root) is product truth. `docs/design-system.html` is the canonical primitive-markup reference: open it and copy primitive markup verbatim — never hand-write a primitive. PHOSPHOR tokens only — no raw hex outside `app/styles/phosphor.css`.

**Design flow (context once per session, then the request's playbook):**

1. Run `.agents/skills/impeccable/scripts/impeccable context` once per session; follow its directives.
2. Load the request's playbook from `.agents/skills/impeccable/reference/` — its Commands-table reference for an explicit/implied sub-command, or `new-work.md` for a new surface / replacement visual world.
3. Read `craft-floor.md` immediately before any UI edit.
4. Implement in the real app.
5. After UI work, run `.agents/skills/impeccable/scripts/impeccable detect --json <changed targets>` once (no hooks are installed, so the detector runs manually).

A new or redesigned surface runs `init` (captures `PRODUCT.md`) → `new-work` → `DESIGN.md`: replace the previous visual world rather than polishing a discarded look.

**Change spec (replaces the wireframe's structure pin):** every UI change carries a short spec in its plan/PR — the regions it touches, its states matrix (empty / loading / error / partial / denied), the real copy, and which design-system components and tokens it uses. Never add a screen, state, or component the spec does not name without explicit user approval.

## Frontend design workflow

The operating procedure for UI/UX work is `.agents/skills/frontend-workflow/SKILL.md` — load it before any design change or frontend implementation. It is binding: it composes Impeccable (the design process) with the antislop filter, over Lexa's design system. The points below are the ones that must survive compaction.

- **Roles.** `@designer` owns design direction and visual review and runs on the design-model tier; `@swe` implements in React and runs on the implementation tier. Neither edits the other's files. A design decision the specs cannot settle escalates to `@designer` as a `task` handoff: screenshot path or preview URL + intended direction + acceptance criteria + a numbered list of unresolved problems, asking for **prioritized corrections, not a redesign**. If the design model cannot be invoked, never claim a review that did not happen — produce the handoff artifact and name the outstanding review in the report.
- **No escalation for the obvious.** A spacing, responsive, or styling fix that follows from `DESIGN.md` and the primitives is implemented directly; the design model is not consulted for it.
- **Quality filter (anti-slop) — mandatory, and it complements Impeccable.** For UI work load `~/.agents/skills/antislop/SKILL.md` plus the sub-skill matching the touch (`antislop-ui`, `antislop-human`, `antislop-layoutmobile`, `antislop-copywriting`). It is a filter, not the direction — `DESIGN.md` and the primitives are the direction. After UI work both antislop *and* Impeccable's `detect` are run; dedupe the findings, and neither substitutes for the other. antislop's Delivery Gate is mandatory: append its one-line-per-item PASS/FAIL-with-evidence block to `status/<plan>/report.md`, and fix a FAIL before delivering. A deliberate pattern stays when the reason is written down.
- **Verification composition** (all of it, not a substitute for any part): `bun run dev` (:5173) + agent-browser against the running app covering the affected screen's void states and at least mobile + desktop → lane tests → `bash scripts/verify-gate.sh` → antislop Delivery Gate → Impeccable `detect`. Snapshot-first when the model lacks vision; hand any image to `@vision`, never to a text-only model.
- **Efficiency.** One meaningful revision by default; never generate a preview nobody will inspect; during refinement fix the three highest-impact issues instead of rewriting the interface; when fixes stop converging, escalate.

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
| 7 | Task, wiki, revision, comment, and Assistant document payloads are canonical Markdown strings; saves preserve source and legacy TipTap conversion exists only in isolated offline upgrade tooling. Old object payloads are rejected; no runtime JSON guessing or public TipTap shim. | One representation across storage, API, and consumers. |
| 8 | Webhook route has no API-key middleware — HMAC-SHA-256 signature verification over the raw body is the auth, and it runs before JSON parsing. | Webhook auth is signature, not bearer. |
| 9 | Column→GitHub state mapping uses `columns.github_state`, never column names. | Decouples labels from identifiers. |
| 10 | `required_fields` enforced on create, move, AND update, with Markdown-aware meaningful-content emptiness. | No silent bypass. |
| 11 | An issue links to at most one task; a task may hold several issues, one per repo (`task_github_issues` PK `(task_id, issue_id)` + `UNIQUE(issue_id)` + per-repo ALREADY_LINKED guard). | One-way link integrity. |
| 12 | Emission invariant. Every task mutation except deletion appends `task_activity` row(s) in the SAME transaction — one row per meaningful change (updates may emit several `field_changed` rows); position-only reorders emit nothing; webhook moves emit `github_synced` only. Task delete emits no activity row (`task_activity` rows cascade with the task). Messages come from the catalog (`server/activity-messages.ts`), frozen at write time — never hand-rolled at call sites. | Audit log + copy consistency. |
| 13 | Ticket keys are immutable. `projects.key` (prefix) + `tasks.number` written once at create, never reused. `PREFIX-n` accepted as task lookup alias everywhere a task id is. `projects.next_task_number` advances atomically; `UNIQUE(project_id, number)` index is the backstop, never a license to reuse. | Stable identifiers. |
| 14 | Milestone/sprint rules. A milestone with sprints can't be deleted (`HAS_CHILDREN`); deleting a milestone loosens its sprints (`ON DELETE SET NULL`), never cascades; archiving a milestone archives its sprints; exactly one Backlog per project (partial unique index), can't be archived or deleted. Sprint progress counts a task done when its column is a done column OR it is archived. | Backlog + sprint integrity. |

## Agent file boundaries

These rules are non-negotiable and apply to every agent working on Lexa:

- **@designer may only modify:**
  - `DESIGN.md` and `PRODUCT.md` (root)
  - `.impeccable/**` (the design sidecar: `design.json`, `surfaces/*.md`, `critique/*.md`, `config.json`)
  - `docs/design-system.html` (PHOSPHOR primitives)
- **@designer must never touch:**
  - `app/`, `server/`, `shared/`, `cli/` (all implementation belongs to @swe)
  - `package.json`, `tsconfig.json`, `app.config.ts`
- **@swe owns all implementation:** `app/components/`, `app/routes/`, `app/styles/`, `app/lib/`, `server/`, `shared/`, `cli/`. Implement UI from `DESIGN.md` + the primitives in `docs/design-system.html`; a missing or drifted decision → report back for a design pass, never invent UI.
- **@fixer scope is per-task** — specify exact files; same constraints apply unless the task explicitly includes backend files.
- If an agent discovers a need for a new backend endpoint or shared type, it must report back to the orchestrator — never add it itself.

## Code conventions

- **Effect-TS everywhere on the backend.** Services/repos use `Effect.Service<Name>()("Lexa/Name", { effect: Effect.gen(...) })`. Domain errors are `Data.TaggedError`. Repos surface `RowNotFound | DbError | ConstraintViolation`; services map to domain errors per the catalog.
- **Repos are thin.** Raw SQLite prepared statements via bun:sqlite. No business logic in repos. `updated_at = datetime('now')` inside every UPDATE statement.
- **Routes are thinner.** `@effect/platform` HttpApi groups; parse → call service → return. Error→status mapping is declarative (`.addError`), from the catalog — no hand-rolled try/catch responses.
- **Frontend:** TanStack Query for all server state; components conform to `DESIGN.md` tokens plus the primitives in `docs/design-system.html` exactly. PHOSPHOR tokens only — no raw hex outside `phosphor.css`. Update cache via `setQueryData` from mutation responses only; never `invalidateQueries` on the mutation path.
- **File placement:** `app/` (TanStack Start routes + components), `server/` (db/repos/services/api/github), `shared/` (types + pure functions). Nothing else at root except config.

## Verification

```bash
tsc --noEmit                    # must pass at every phase gate
bun run dev:workers             # local smoke testing (one workerd instance)
```

Lane-scoped tests for iteration (pick your lane — `test`/`test:full` stay for pre-merge):

| Lane | Command | Scope |
|---|---|---|
| shared/pure | `bun run test:shared` | `shared/` (~150 tests, fastest) |
| backend | `bun run test:be` | `shared/` + `server/` incl. `server/api` |
| frontend | `bun run test:fe` | `shared/` + `app/` |
| app-only | `bun run test:app` | `app/` (fastest frontend loop) |
| cli | `bun run test:cli` | `cli/src/` |

Full suite (`bun run test` / `test:full`) + `check:invariants` run at the final gate / release CI. CI runs only at release preparation — a push to `chore/release-*` / `release/*` or a manual `workflow_dispatch`; PRs and main merges rely on the local gate (`bash scripts/verify-gate.sh`) plus review (see `.github/workflows/ci.yml`).

**Quick gate** — `bash scripts/verify-gate.sh` runs typecheck first, then
**scopes the test step to the changed areas**: `app/**` → fe (`test:fe`),
`server/**`/`shared/**`/`migrations/**` → be (`test:be`), `cli/**` only → cli
(`test:cli`), cli mixed with app/be or any tooling/unknown path → full (`test`),
app+be mixed → one deduped `shared+server+app` run, `status/**` or `*.md`-only →
tests skipped (typecheck still runs), no changes → full. Force the full suite
with `--full`; override the lane with `--lane=<fe|be|cli|full>` (accepts
`scripts/ci-local.sh`'s `fe|be|cli` tokens plus `full`; ci-local also has
`shared` and rejects `full`); print the chosen lane + command without running anything
with `--print-plan`.

**Iteration contract:** during iteration run only the touched test file(s)
(`bun run test -- <path>`, ~1s each); run the lane (`test:app`/`test:fe`/
`test:be`/`test:cli`) at lane close; run the full suite only at pre-merge.

**Test guard rail** (rules, budget, and the invariant→test map live in `docs/TESTING.md`): write minimal and
important tests only. Enforced by `bun run check:test-hygiene`, which `scripts/verify-gate.sh` runs on
every gate.

1. **Name the criterion before writing the test.** It must be one of: an architectural invariant (the 14
   in `scripts/check-invariants.ts`), a documented contract (`docs/API.md`, `docs/SCHEMA.md`,
   `docs/LAYERS.md`), a security/auth boundary, a race/atomicity property, a migration/upgrade path, a
   destructive operation, or a core-flow smoke. No criterion → do not write the test.
2. **One test per effect, at the tier where the effect lives.** Route-level for the documented HTTP
   contract, service-level for domain rules, db-level for schema/migration, the static scanner for
   structural invariants, one smoke per UI surface. Never restate at a second tier.
3. **Banned** (the checker fails a gate on these): snapshot assertions; and any *new* use of
   `toHaveClass`/`toHaveStyle`, `toBeTruthy`/`toBeDefined`, `toHaveBeenCalledWith` (mock-argument echo)
   or `readFileSync` — those are recorded per file in `scripts/test-hygiene-allow.json` as a ratchet that
   only tightens. Also banned by judgment: copy/label/px pins, internal wiring, source-text scans,
   implementation-detail pins, and tests whose subject has no production caller.
4. **Budget**: 100 files / 900 cases / 27k LOC of tests. Exceeding a ceiling is a warning; growth needs a
   stated criterion in the PR/commit body, not a silent addition.
5. **Ceilings are not a license to duplicate**: prefer extending an existing case's assertions over
   adding a near-identical case, and never re-pin existing wording/implementation behavior — delete it.
   Invariant→test map, non-droppable surfaces and the checker's rules: `docs/TESTING.md`.

Acceptance checks live in `docs/GITHUB_SETUP.md` (sync round-trip) — run them and paste the output.

### Running the dev stack (Bun by default)

The `.env.toml` file is **required** — `bun run setup` writes it (dev-only;
self-hosters use the install script + `/setup` wizard). `dev` reads it via
`server/entry.ts` at boot; the local Worker reads it through the generated
`.dev.vars`. A legacy flat `.env` is read as a one-release fallback.

```bash
bun run setup          # first-time: admin email, API key, migrations, sample data
bun run dev            # default: Bun stack — API :3000 + vite :5173, Ctrl-C stops both
# open http://localhost:5173
```

`bun run dev` is the day-to-day loop: it boots `server/entry.ts` on :3000 and
vite on :5173 (vite proxies `/api` → :3000) and sets `LXK_SEED_DEV=1` for
sample data. `bun run dev:workers` is the local Worker flavor: one workerd
instance (via `@cloudflare/vite-plugin`) co-hosts the SSR handler and the API
on :5173, so `/api/*` is served directly (no proxy, no separate Bun process).
`bun run dev:remote` runs vite only, proxying `/api` to a remote server
(default staging). The local Worker's D1 (`.wrangler/state/v3/d1`) is separate
from `bun run setup`'s Bun SQLite (`data/lexa.db`); a fresh Worker DB lands on
`/setup` (web wizard), or seed it with `bun x wrangler d1 execute DB --local
--file scripts/seed-dev.sql`.

**Env files — which one is for what:**

| File | Role | Read by |
|---|---|---|
| `.env.toml` | canonical local dev env (gitignored) | `dev` via `scripts/dev.sh`, `dev:workers` via `scripts/dev-workers.sh` (source for `.dev.vars`), `bun run setup` |
| `.dev.vars` | generated from `.env.toml`; regenerated when `.env.toml` is newer, else reused | `dev:workers` (wrangler) |
| `.env.staging.toml` | staging deploy key custody — TOML, one key `LXK_SECRETS_MASTER_KEY` (gitignored, 0600) | `scripts/deploy-staging.sh` |
| `.env.toml.example` | template for `.env.toml` | — |
| `wrangler.jsonc` | prod Workers config (placeholder ids) | wrangler, `dev:workers` |
| `wrangler.staging.local.jsonc` | staging custody config (gitignored) | `scripts/deploy-staging.sh`, `bun run staging:pull` |
| `wrangler.staging.example.jsonc` | staging config template | — |
| `~/apps/lexa/cf-workers/.env.toml` | prod deploy custody (`LXK_SECRETS_MASTER_KEY`) | prod install/deploy |

A one-time converted flat `.env` may sit next to these as `.env.legacy` — nothing reads it.

`scripts/dev.sh` (what `bun run dev` runs) loads `.env.toml` (or a
legacy `.env`) into the shell via the loader's exports, boots
`server/entry.ts` on :3000 and `vite dev` on :5173 (vite proxies `/api` → :3000),
and sets `LXK_SEED_DEV=1` for sample data on every boot. Delete `data/lexa.db*`
to start fresh. DB lives at `data/lexa.db` (SQLite WAL). Health check:
`curl http://localhost:3000/api/health` → `{"ok":true}`. On the local Worker
flavor the same check is `curl http://localhost:5173/api/health`.

Key facts:

- **dev.sh exports the resolved env file into the shell** — the API server and
  vite both inherit `.env.toml` values from the process environment, since
  vite is not TOML-aware (it still auto-loads a legacy flat `.env` if one
  exists). Browsers authenticate via the session cookie — no key in the bundle.
- **Re-running `bun run setup` is safe:** browsers authenticate via the session
  cookie, and setup mints `LXK_SECRETS_MASTER_KEY` only when the env file lacks
  one (never rotated on re-run), so a re-run never breaks the browser — no
  rebuild required.
- **`bun run dev:server` alone** serves the **built** app from `dist/` on :3000
  (frontend changes require `bun run build` first). Use it only for API work
  or to preview the production build; use `bun run dev` for day-to-day
  development.
- **Local Worker flavor:** `bun run dev:workers` runs `@cloudflare/vite-plugin` with
  `remoteBindings: false` (the `ai` binding is permanent-remote and would stall
  boot on "Establishing remote connection..."). `workers_ai` assistant models
  therefore do not work locally — configure an external provider instead. The
  deployed Worker still carries the real `ai` binding.
- **Setup wizard** (`scripts/setup-cli.ts` / web wizard `/setup`): prompts for
  admin email (`LXK_ADMIN_EMAILS`), mints `LXK_SECRETS_MASTER_KEY` once when the
  env file lacks one (kept verbatim on re-run), runs
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
- **GitHub sync:** connect the App in the web app — Settings → Workspace →
  Integrations → GitHub Sync; full guide in `docs/GITHUB_SETUP.md`. Legacy
  `GITHUB_*` env vars are warned and ignored. Webhook auth is HMAC-SHA-256
  over the raw body — no Access bypass needed.

## Reference (read the linked doc/skill, don't inline it here)

- **Releasing:** `docs/RELEASING.md` — version policy, pre-tag checklist, image flow, CLI build flow, deploy state.
- **lexa-cli operator tool:** the `lexa-cli` skill. Install it into a harness
  skill dir with `lx skill install --global` (→
  `~/.agents/skills/lexa-cli/SKILL.md`) or `lx skill install --local` (→
  `./.agents/skills/lexa-cli/SKILL.md`). Load it before any CLI work.
  lexa-cli is operate-only — no deploy commands (removed in cli-v2026.2.0;
  self-hosting goes through `scripts/install.sh`).
- **Frontend design workflow:** the `frontend-workflow` skill
  (`.agents/skills/frontend-workflow/SKILL.md`, committed with this repo) — the operating
  procedure for any UI/UX change: it composes Impeccable (the design process) with the
  antislop filter over Lexa's design system — authority order, design-vs-implementation
  roles, escalation handoff, verification composition, delivery criteria.
- **Design system (Impeccable):** the `impeccable` skill (`.agents/skills/impeccable/`;
  engine launcher `.agents/skills/impeccable/scripts/impeccable`). Run
  `scripts/impeccable context` once per session, load the request's playbook from
  `.agents/skills/impeccable/reference/` (`new-work.md` for a new surface), read
  `craft-floor.md` before any UI edit, and run `scripts/impeccable detect --json <targets>`
  once after UI work. `DESIGN.md` + `.impeccable/design.json` are the design authority;
  `PRODUCT.md` is product truth.
- **Anti-slop filter:** `~/.agents/skills/antislop/SKILL.md` plus the sub-skill matching the
  touch (`antislop-ui`, `antislop-human`, `antislop-layoutmobile`, `antislop-copywriting`).
  A filter over the design, never the design itself; its Delivery Gate report belongs in
  `status/<plan>/report.md`. Mode-2 audit artifacts go to `anti-slop/` (gitignored).
- **Browser automation:** the `agent-browser` skill (auto-discovered; at
  `~/.agents/skills/agent-browser/SKILL.md`). Load it before any browser
  work. If the active model lacks vision, the skill defaults to snapshot-
  first debugging (text-based accessibility tree, semantic locators) instead
  of screenshots.

## When you're stuck

1. Re-read the relevant design doc section — the answer is usually there.
2. If you're tempted to change an invariant, re-read its rationale in `docs/ARCHITECTURE.md` and the design notes in `docs/SCHEMA.md` (they explain why each exists).
3. If genuinely blocked or docs are ambiguous: **stop and ask the user.** State what's ambiguous and what you would otherwise do. Do not guess on architecture.

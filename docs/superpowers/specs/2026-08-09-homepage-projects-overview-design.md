# Homepage (Projects Overview) + Project Route Restructure — Design

- Date: 2026-08-09
- Status: Approved
- Supersedes the routing arrangement from `docs/lexa-dashboard-plan.html` (status view at `/`, board at `/$slug`).

## Goal

Give Lexa a homepage at `/`: an overview of all projects that acts as the project switcher, entered via the "Lexa" brand logo in the nav. The current `/` status view becomes the per-project dashboard at `/$slug`; the board moves to `/$slug/board`.

## User decisions (verbatim intent)

- `/` is home: overview of all projects and project switcher.
- We still keep the current dashboard (status view) — it moves, not dies.
- "Lexa" brand logo acts as the navigation menu — clicking it goes home.
- Project dashboard lives at `/{project}`; board lives at `/{project}/board`.
- Existing ProjectSwitcher dropdown in nav-right stays.
- Homepage cards are minimal: name, description, health dot. No numbers, no activity.

## Route architecture

| Route | Page | Origin |
|---|---|---|
| `/` | **Homepage** — all projects overview (cards grid) | rewrite of `app/routes/index.tsx` |
| `/$slug` | **Project dashboard** — status view: header + settings modal, stats bar, Column WIP, Needs Attention | content moved verbatim from current `/` (into `app/routes/$slug/index.tsx`) |
| `/$slug/board` | **Board** — columns, tasks, `?task=` detail slideover | current `app/routes/$slug/index.tsx` moved to `app/routes/$slug/board.tsx` |
| `/$slug/tasks` | Tasks list | unchanged |
| `/$slug/wiki` | Wiki | unchanged |
| `/$slug/settings` | Project settings | unchanged |
| `/settings`, `/forge`, `/setup` | Unchanged | unchanged |

## Navigation (AppShell)

- `nav-brand` "Lexa" becomes a NavLink to `/` (home). Active styling when `routeType === "home"`.
- Nav tabs, in order: **Dashboard** (to `/$slug` when a project is selected, `/` fallback; active on `routeType === "dashboard"`), **Board** (to `/$slug/board`; active on `routeType === "board"`), **Tasks**, **Wiki**, **Settings**, **Forge**.
- `routeType` mapping updates:
  - `/` → `"home"`
  - `^\/[^/]+\/board$` → `"board"`
  - `^\/[^/]+$` → `"dashboard"` (project dashboard)
  - `^\/[^/]+\/tasks$` → `"tasks"`; wiki/settings regexes unchanged; `/forge`, `/settings` → `"dashboard"`/`"settings"` as today.
- Nav fallbacks when no project selected (`boardTo`/`wikiTo`/`tasksTo`/`dashboardTo`): `/$slug`-shaped targets fall back to `/`.

## Homepage (`/`)

- Header: "Projects" title + **New Project** button (`?new=1` modal flow, verbatim from today).
- Cards grid: one card per project — **name, description, health dot** (dot color from existing `selectProjectHealth`/`useDashboard` derivation; zero backend). Card click → `/$slug` (project dashboard).
- Projects with no description render without a description line.
- Empty state: current "No projects yet" block, verbatim (icon, copy, New Project CTA).
- Setup-incomplete banner: current `needsSetup` banner + `/setup` redirect logic (`getSetupStatus`), verbatim.
- Card/selection behavior: entering a project keeps the existing `useProjectSelection` behavior (selecting the slug from the URL).

## Project dashboard (`/$slug`)

- Verbatim move of today's status view: header (health dot, project name, "Project status" micro-label), settings button (ProjectSettingsModal), stats bar (Total tasks / WIP exceeded / Out-of-sync), Column WIP rows, Needs Attention cards.
- **Link retargets**: Column WIP rows → `/$slug/board`; Needs Attention items → `/$slug/board?task=<id>` (the detail slideover lives on the board route).
- "New Project" button does NOT move here (homepage owns project creation). Settings modal stays.
- Loading skeleton stays, retargeted unchanged.
- `?new=1` handling stays on the homepage only.

## Board (`/$slug/board`)

- Current board route file moves from `app/routes/$slug/index.tsx` to `app/routes/$slug/board.tsx`; component content, `?task=` slideover, column/lane logic unchanged.
- Any internal links previously pointing at `/$slug` to mean "the board" retarget to `/$slug/board` (see Churn list).

## Churn list (all existing references, grep-verified during implementation)

- `app/components/layout/AppShell.tsx` — routeType map, brand NavLink, tab targets (`/$slug` → dashboard, board → `/$slug/board`).
- `app/components/layout/ProjectSwitcher.tsx` — per-routeType targets: board context → `/$slug/board`, dashboard context → `/$slug`, home → `/$slug` (enter project); "Create new project" → `/?new=1` unchanged.
- `app/routes/$slug/tasks.tsx` — empty-state "Open board" link → `/$slug/board`.
- `app/routes/$slug/wiki*` — any board links (grep `/$slug` Link usages during implementation).
- `app/routes/index.tsx` — rewritten as homepage (homepage owns `?new=1`, setup banner, create modal).
- `app/routes/$slug/index.tsx` — rewritten as project dashboard (status view + settings modal).
- Selection side effect: whichever route observes the slug to auto-select (board route today) moves with the board file. `useProjectSelection` unchanged.
- MCP/server: no changes (MCP speaks task/wiki/project names, not frontend routes). Verify with grep for `/$slug` in `server/` and `shared/` — expected zero hits.

## Wireframes (wireframe-first, non-negotiable)

1. `wireframes/src/home.html` — new homepage wireframe: header, cards grid (name/description/health dot), hover/active states, empty state, setup banner, `?new=1` modal trigger. Annotated per project conventions.
2. `wireframes/src/partials/navbar.html` — brand as home link; Dashboard/Board tab labels and targets updated.
3. `wireframes/src/index.html` + `flow-overview.html` — homepage entry + updated flow (logo → home; project → dashboard; board → `/$slug/board`).
4. `wireframes/src/dashboard.html` — retarget link annotations (column rows → board; attention items → board with `?task=`).
5. Run `bash wireframes/build.sh`; gate before any React lane.
6. New wireframe CSS classes ported to `app/styles/phosphor.css` (PHOSPHOR tokens, flat selectors).

## Non-goals

- No backend changes (`server/`, `shared/types.ts`, `docs/API.md`, `docs/SCHEMA.md` untouched).
- No new endpoints; homepage uses existing `GET /api/dashboard`.
- No activity feed, no per-project numbers on cards, no archived-project special handling.
- No changes to tasks/wiki/settings pages beyond link retargets.
- No MCP or CLI changes.

## Verification

- `tsc --noEmit` at every gate.
- `vitest run` (shared modules) — expected unaffected, must stay green.
- `bash wireframes/build.sh` green.
- Live smokes (agent-browser, no vision):
  - Brand logo → `/`; brand active on home; Dashboard tab inactive on home.
  - Homepage lists all projects; card shows name + description + health dot; click → `/$slug` (project dashboard).
  - `/$slug` renders status view; column row → `/$slug/board`; attention item → `/$slug/board?task=<id>` + slideover opens.
  - `/$slug/board` renders board; `?task=` deep link opens slideover; board tab active.
  - Tasks page "Open board" → `/$slug/board`.
  - ProjectSwitcher: on board page switching project → `/$slug/board`; on dashboard → `/$slug`; on home → `/$slug`; create → `/?new=1` opens modal.
  - Empty project: dashboard renders zeros; board renders empty board.
  - No-project state: `/` empty state + New Project; setup redirect intact (fresh DB).
- Backend drift: `git diff --stat` vs `server/`, `shared/types.ts`, `docs/API.md`, `docs/SCHEMA.md` = zero.

## Out of scope (future, not built now)

- Card numbers/metrics (task counts, WIP) — user chose minimal cards.
- Recent-activity per project.

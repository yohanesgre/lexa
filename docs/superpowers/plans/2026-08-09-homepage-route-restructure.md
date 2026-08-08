# Homepage + Project Route Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a homepage at `/` (all-projects overview, entered via the "Lexa" brand logo), move the status view to `/$slug` (project dashboard), and move the board to `/$slug/board`.

**Architecture:** Frontend-only route restructure. The homepage renders project cards from the existing `useDashboard()` cache (`dashboard.projects` → `ProjectHealth[]`, zero backend). The status view content moves verbatim from `app/routes/index.tsx` into `app/routes/$slug/index.tsx`; the board file moves from `app/routes/$slug/index.tsx` to `app/routes/$slug/board.tsx` with its route path changed.

**Tech Stack:** TanStack Start file routes, TanStack Router `Link`/`NavLink`/`navigate`, TanStack Query (`useDashboard`, `useBoard`), React, wireframes (`wireframes/src/` + `bash wireframes/build.sh`), phosphor.css tokens.

## Global Constraints

- **Wireframe-first (non-negotiable):** Task 1 (wireframes) MUST complete and pass its gate BEFORE Task 2 starts. Code transcribes the wireframes exactly; never run wireframe work and React lanes in parallel.
- **No commits unless the user explicitly asks.** All work lands in the working tree; the user requests the commit.
- **Zero backend edits:** `server/`, `shared/types.ts`, `docs/API.md`, `docs/SCHEMA.md`, `package.json`, `app.config.ts` untouched. If a task needs a backend change, STOP and report to the orchestrator.
- **Verbatim moves:** the status view and board components move WITHOUT redesign — same markup, same classes, same logic. Only route paths, links, and error-handling wiring change.
- **Names are exact:** route paths `/`, `/$slug`, `/$slug/board`; class-name contract for new homepage UI: `project-cards`, `project-card`, `project-card-name`, `project-card-desc`; brand active state: `.nav-brand` with an `active` class modifier. Wireframe task uses exactly these names.
- **No new CSS tokens or raw hex** — only PHOSPHOR CSS variables.
- TypeScript strict; `tsc --noEmit` must pass at every gate.

---

### Task 1: Wireframes — homepage + nav retargets (designer)

**Files:**
- Create: `wireframes/src/home.html`
- Modify: `wireframes/src/partials/navbar.html`, `wireframes/src/dashboard.html`, `wireframes/src/index.html`, `wireframes/src/flow-overview.html`, `wireframes/src/wireframes.css`

**Interfaces:**
- Consumes: existing wireframe conventions (`<INCLUDE partials/navbar.html />`, annotation spans, PHOSPHOR variables in `wireframes.css`); current `wireframes/src/partials/navbar.html` brand `<a href="index.html" class="nav-brand">Lexa</a>`, Dashboard tab → `dashboard.html`, Board tab → `kanban.html`.
- Produces: `wireframes/src/home.html` with EXACT class names `project-cards`, `project-card`, `project-card-name`, `project-card-desc`, `nav-brand` active state (e.g. `nav-brand active`); `wireframes.css` rules for these classes; navbar partial with brand as home link and Dashboard/Board tabs retargeted. React tasks 2–8 transcribe these.

- [ ] **Step 1: Create `wireframes/src/home.html`**

  New homepage wireframe (include the standard `<INCLUDE partials/navbar.html />` header). Content, in order:

  1. Header row: "Projects" title + "New Project" button (existing `btn btn-primary` style).
  2. Cards grid: `<div class="project-cards">` — grid of `<a class="project-card">` items. Each card: name line (`<span class="project-card-name">` + leading `health-dot health-dot-ok|approaching|exceeded` span), description line (`<span class="project-card-desc">`), card click → `/$slug` (project dashboard) per annotation. Show 4 cards in varying health states; one card WITHOUT a description (desc line omitted).
  3. States (annotation-tagged, visible in rendered wireframe):
     - Empty project list → existing `empty-state` block (icon, "No projects yet", copy from `dashboard.html`'s current empty state, New Project CTA).
     - Setup-incomplete banner (amber, "Setup incomplete — no admin email is configured" + "Finish setup" link).
     - `?new=1` → CreateProjectModal trigger note.
  4. Annotations: brand logo = navigation menu (goes to `/`); card anatomy; click → `/$slug`.

- [ ] **Step 2: Update `partials/navbar.html`**

  - Brand: keep `href="index.html"` but annotate "Lexa brand = homepage (route `/` in the app)". Add an active-state rendering of the brand (`class="nav-brand active"` variant) with the state labeled.
  - Tabs: Dashboard link stays `dashboard.html` — but Dashboard.html now represents the PROJECT dashboard at `/$slug`; update its annotation. Board tab `kanban.html` → annotate "app route `/$slug/board`".
  - Project switcher annotation (line ~132): replace "Picking a project from the dashboard stays on `/`; from board/wiki rows target `/$slug`" with: "From the homepage (`/`) and from the project dashboard (`/$slug`) picking a project targets `/$slug`; from board (`/$slug/board`) rows target `/$slug/board`; wiki rows target `/$slug/wiki`. 'Create new project' → `/?new=1`."
  - Switcher row hrefs: `dashboard.html` rows now mean the project dashboard — keep `dashboard.html` but annotate app route `/$slug`.

- [ ] **Step 3: Update `dashboard.html` link annotations**

  Find the Column WIP rows and Needs Attention items (they link to `kanban.html` / board today — verify current hrefs). Annotate: app route `/$slug/board` for column rows; `/$slug/board?task=<id>` for urgent/out-of-sync items (slideover opens on the board).

- [ ] **Step 4: Update `index.html` and `flow-overview.html`**

  - `index.html`: add a `home.html` entry to the surface index (title "Homepage — projects overview").
  - `flow-overview.html`: update canonical flow — brand/logo → `/` (homepage); project card → `/$slug` (project dashboard); dashboard column/attention → `/$slug/board`; board stays the work surface at `/$slug/board`.

- [ ] **Step 5: Build + gate**

  Run: `bash wireframes/build.sh`
  Expected: builds clean, no errors. Verify `wireframes/dist/home.html` exists. Gate: build renders · annotations present (visible `annotation`/`annotation-tag` spans, no plain HTML comments for decisions) · no `wireframes/dist/` hand-edits.

---

### Task 2: Move board route to `/$slug/board` (fixer)

**Files:**
- Move: `app/routes/$slug/index.tsx` → `app/routes/$slug/board.tsx`
- Regenerate: `app/routeTree.gen.ts` (via vite build — gitignored)

**Interfaces:**
- Consumes: current `app/routes/$slug/index.tsx` (201 lines, `createFileRoute("/$slug/")`, BoardPage with `?task=` slideover, board mutations).
- Produces: `app/routes/$slug/board.tsx` exporting `Route = createFileRoute("/$slug/board")` and the unchanged `BoardPage`. Tasks 5–7 rely on route path `/$slug/board` existing.

- [ ] **Step 1: Move the file**

  Run: `mv app/routes/$slug/index.tsx app/routes/$slug/board.tsx`

- [ ] **Step 2: Change the route path**

  In `app/routes/$slug/board.tsx`, change:
  ```ts
  export const Route = createFileRoute("/$slug/")(
  ```
  to:
  ```ts
  export const Route = createFileRoute("/$slug/board")(
  ```
  Nothing else in the file changes (component body, `validateSearch { task?: string }`, mutation wiring, slideover).

- [ ] **Step 3: Regenerate the route tree**

  Run: `npx vite build` (TanStack plugin regenerates `app/routeTree.gen.ts`; the file is gitignored).
  Expected: build completes; `routeTree.gen.ts` now contains `/board_/$slug`-style entries for the moved route.

- [ ] **Step 4: Gate — typecheck**

  Run: `tsc --noEmit`
  Expected: PASS. If other files still reference `/$slug` as the board route they still typecheck (routes are typed loosely), so this gate only proves the move is type-clean.

---

### Task 3: Project dashboard at `/$slug` (fixer)

**Files:**
- Rewrite: `app/routes/$slug/index.tsx`
- (No changes to `app/routes/index.tsx` in this task — Task 4 owns it.)

**Interfaces:**
- Consumes: current status-view content in `app/routes/index.tsx` (header/health-dot/status sections, `StatusSections`, `columnState` helper, ProjectSettingsModal wiring, `selectProjectHealth` from `../../lib/queries`, `useBoard`).
- Produces: `app/routes/$slug/index.tsx` = the project dashboard page at `/$slug`. Route `/$slug` must render the status view; links to `/$slug/board` and `/$slug/board?task=<id>` (Tasks 5–7 use them).

- [ ] **Step 1: Move the status view into `app/routes/$slug/index.tsx`**

  Copy from `app/routes/index.tsx` into the NEW `app/routes/$slug/index.tsx` (replacing the board content, which moved in Task 2):

  - `export const Route = createFileRoute("/$slug/")({ component: ProjectDashboard })`
  - `ProjectDashboard()`: params `{ slug }` via `Route.useParams()`; `const health = selectProjectHealth(dashboard, selectedSlug)` — use the URL slug: `selectProjectHealth(dashboard, slug)` (the route's own slug, not the provider's selection).
  - Header block: health dot (`health-dot health-dot-${health.health}`), project name, "Project status" micro-label, settings button (ProjectSettingsModal with `updateProject`/`deleteProject`; onDelete → `navigate({ to: "/" })`).
  - `<StatusSections dashboard={dashboard!} health={health} />` moved verbatim (with `columnState` helper and `useBoard(slug)` inside).
  - Loading skeleton: keep the current `index.tsx` loading branch (page-frame + skeleton header + stat cards + list rows), keyed off `useDashboard().isLoading`.
  - NOT moved here: `?new=1` handling, "New Project" button, `needsSetup` banner, `isEmpty` branch, `CreateProjectModal` — homepage owns those (Task 4).

- [ ] **Step 2: Retarget links inside the moved sections**

  In `StatusSections` (now in `$slug/index.tsx`):
  - Column WIP row: `<Link to="/$slug" params={{ slug }} search={{}}>` → `<Link to="/$slug/board" params={{ slug }} search={{}}>`
  - Urgent task item: `to="/$slug"` + `search={{ task: task.id }}` → `to="/$slug/board"` (search unchanged)
  - Out-of-sync item: same retarget to `to="/$slug/board"` (search `{ task: sync.id }` unchanged)

- [ ] **Step 3: Error handling for bad/missing project**

  Mirror the board's pattern (it is the established `$slug`-route convention):
  - If `useBoard(slug)` errors → `<div className="board-error">Failed to load board: {message}</div>` (reuse class; or a `.dashboard-error` div with the same text pattern — follow what the wireframe/phosphor offers).
  - If `board` data is undefined after load → `<div className="board-error">Project not found</div>`.
  - If `health` is undefined but board exists (project without dashboard entry) → render the status sections with zeros naturally; do NOT show the homepage empty state here.

- [ ] **Step 4: Gate — typecheck**

  Run: `tsc --noEmit`
  Expected: PASS. Confirm `app/routes/index.tsx` still compiles in its pre-rewrite state (it may reference `StatusSections` until Task 4 rewrites it — if so, temporarily keep the old `index.tsx` compiling by leaving `StatusSections` exported/duplicated there until Task 4 lands; if TS complains about unused exports, that's fine — unused exports typecheck).

---

### Task 4: Homepage at `/` (fixer)

**Files:**
- Rewrite: `app/routes/index.tsx`

**Interfaces:**
- Consumes: `useDashboard()` + `selectProjectHealth`-adjacent data (`dashboard.projects: ProjectHealth[]`), `Project` shape (`{ id, name, slug, description, githubRepo, createdAt, updatedAt }`), `useProjectSelection` (`setSelectedSlug`), `CreateProjectModal`, `getSetupStatus`; wireframe classes from Task 1 (`project-cards`, `project-card`, `project-card-name`, `project-card-desc`).
- Produces: homepage at `/`. Cards link to `/$slug` and call `setSelectedSlug` on click. Route `/` no longer renders the status view.

- [ ] **Step 1: Rewrite `app/routes/index.tsx`**

  New homepage component `Home()` with `createFileRoute("/")`:

  - Keep verbatim from today: `getSetupStatus` effect (fresh-install → `/setup`; else `needsSetup` banner), `?new=1` search param → `CreateProjectModal` open + param cleared, loading branch, empty-state block ("No projects yet" + New Project CTA).
  - Header: "Projects" title + "New Project" button (same as current empty-state header).
  - Cards grid (non-empty):
    ```tsx
    const { data: dashboard } = useDashboard();
    ...
    <div className="project-cards">
      {dashboard.projects.map((entry) => (
        <Link
          key={entry.project.id}
          to="/$slug"
          params={{ slug: entry.project.slug }}
          className="project-card"
          onClick={() => setSelectedSlug(entry.project.slug)}
        >
          <span className={`health-dot health-dot-${entry.health}`} />
          <span className="project-card-name">{entry.project.name}</span>
          {entry.project.description ? (
            <span className="project-card-desc">{entry.project.description}</span>
          ) : null}
        </Link>
      ))}
    </div>
    ```
    (`entry.health` is `"ok" | "approaching" | "exceeded"` — the health-dot classes already exist.)
  - Remove: `StatusSections`, `columnState`, settings modal, per-project header — all moved to `/$slug` (Task 3).

- [ ] **Step 2: Gate — typecheck**

  Run: `tsc --noEmit`
  Expected: PASS.

---

### Task 5: AppShell — brand link + routeType remap + tab targets (fixer)

**Files:**
- Modify: `app/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `NavLink` component API (`app/components/layout/NavLink.tsx` — read it; it supports `active` prop and `exact`), `useProjectSelection`, current routeType mapping.
- Produces: brand → home link with active state; routeType values `"home" | "dashboard" | "board" | "tasks" | "wiki" | "settings"`; Dashboard tab → `/$slug` (or `/` fallback); Board tab → `/$slug/board` (or `/` fallback). Task 6 consumes the widened union.

- [ ] **Step 1: routeType mapping**

  Replace the `useMemo` block:
  ```ts
  if (pathname === "/") return "home";
  if (pathname === "/forge") return "home"; // keep current behavior (no tab active)
  if (pathname === "/settings") return "settings";
  if (pathname.match(/^\/[^/]+\/board$/)) return "board";
  if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
  if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
  if (pathname.match(/^\/[^/]+\/settings$/)) return "settings";
  if (pathname.match(/^\/[^/]+$/)) return "dashboard"; // project dashboard
  return "home";
  ```
  (Update the `routeType` type union to include `"home"`.)

- [ ] **Step 2: Brand as home link**

  Replace `<div className="nav-brand">Lexa</div>` with a link to home carrying the wireframe active state (per Task 1's `nav-brand active` variant):
  ```tsx
  <NavLink to="/" exact className="nav-brand" active={routeType === "home"}>
    Lexa
  </NavLink>
  ```
  (Read `NavLink.tsx` first — if it doesn't accept `className`, wrap a `<Link>` with the class and apply the active variant via its API; keep the class `nav-brand` and add the active modifier exactly as the wireframe defines it.)

- [ ] **Step 3: Tab targets**

  - `dashboardTo = selectedSlug ? "/$slug" : "/"`, `dashboardParams = selectedSlug ? { slug: selectedSlug } : undefined`
  - `boardTo = selectedSlug ? "/$slug/board" : "/"`, `boardParams` likewise
  - Dashboard `NavLink`: `to={dashboardTo} params={dashboardParams} active={routeType === "dashboard"} exact`
  - Board `NavLink`: `to={boardTo} params={boardParams} active={routeType === "board"} exact`
  - Tasks/Wiki keep their existing fallback logic (already `/$slug/tasks`, `/$slug/wiki`).

- [ ] **Step 4: Gate — typecheck**

  Run: `tsc --noEmit`
  Expected: PASS (ProjectSwitcher's `routeType` prop union must widen — that's Task 6; if it fails here, the fix is Task 6's first step).

---

### Task 6: ProjectSwitcher targets (fixer)

**Files:**
- Modify: `app/components/layout/ProjectSwitcher.tsx`

**Interfaces:**
- Consumes: widened `routeType` union from Task 5.
- Produces: per-routeType navigation targets: `home`/`dashboard` → `/$slug`; `board` → `/$slug/board`; `wiki` → `/$slug/wiki`; `tasks`/`settings` → `/$slug`. "Create new project" → `/?new=1` unchanged.

- [ ] **Step 1: Widen the union**

  `{ routeType }: { routeType: "home" | "dashboard" | "board" | "tasks" | "wiki" | "settings" }`

- [ ] **Step 2: Retarget `targetFor` and the dashboard branch**

  ```ts
  const targetFor = (slug: string) => {
    if (routeType === "board") return "/$slug/board" as const;
    if (routeType === "wiki") return "/$slug/wiki" as const;
    return "/$slug" as const;
  };
  ```
  Remove the special-cased `routeType === "dashboard"` row branch (lines 93–104): all rows now render through the single `Link` branch with `to={targetFor(project.slug)} params={{ slug: project.slug }}` and `onClick={() => setSelectedSlug(project.slug)}`. The `isCurrent` active-row logic stays. "Create new project" → `to="/" search={{ new: true } as never}` stays.

- [ ] **Step 3: Gate — typecheck**

  Run: `tsc --noEmit`
  Expected: PASS.

---

### Task 7: Remaining board-link churn (fixer)

**Files:**
- Modify: `app/components/SlideoverHeader.tsx`, `app/routes/$slug/tasks.tsx`
- Verify: `app/routes/$slug/wiki*`, `app/components/forge/*`, `app/routes/setup.tsx` (grep — expect zero hits)

**Interfaces:**
- Consumes: `/$slug/board` route from Task 2.
- Produces: every link with board intent points at `/$slug/board`.

- [ ] **Step 1: SlideoverHeader breadcrumbs**

  `app/components/SlideoverHeader.tsx` lines 20 and 34: `<Link to="/$slug" params={{ slug }} search={{}}>` → `<Link to="/$slug/board" params={{ slug }} search={{}}>`. The trailing breadcrumb text " / Board" stays correct (it already says Board).

- [ ] **Step 2: Tasks empty-state CTA**

  `app/routes/$slug/tasks.tsx` line 213: `navigate({ to: "/$slug", params: { slug } } as never)` → `navigate({ to: "/$slug/board", params: { slug } } as never)`.

- [ ] **Step 3: Grep sweep for board-intent links**

  Run: `grep -rn 'to="/\$slug"' app/ | grep -v '/\$slug/board\|/\$slug/tasks\|/\$slug/wiki\|/\$slug/settings'`
  Expected: no remaining hits with board intent (Task 3's retargets are inside `$slug/index.tsx`, already handled). Check any hit file-by-file: if a link means "the project dashboard" it's correct; if it means "the board", retarget to `/$slug/board`.

- [ ] **Step 4: Gate — typecheck + tests**

  Run: `tsc --noEmit` then `vitest run`
  Expected: both PASS (vitest: 75/75 suites green — shared modules untouched).

---

### Task 8: CSS port (designer)

**Files:**
- Modify: `app/styles/phosphor.css`

**Interfaces:**
- Consumes: wireframe classes + values from Task 1 (`wireframes/src/home.html`, `wireframes.css`).
- Produces: `project-cards`, `project-card`, `project-card-name`, `project-card-desc`, `nav-brand` active variant in phosphor.css (flat selectors, PHOSPHOR tokens only).

- [ ] **Step 1: Port the new classes**

  Copy the value of each new wireframe rule into `app/styles/phosphor.css` exactly (grid template, gap, card padding/radius/border/hover, name/desc typography, brand active color/underline) — same discipline as the tasks-list port (23-selector diff was zero at value level).

- [ ] **Step 2: Alignment check**

  Compare every ported selector's declarations against `wireframes.css` — must be value-identical. Report any deviation to the orchestrator; never invent styles not in the wireframe.

- [ ] **Step 3: Gate**

  Run: `tsc --noEmit` · Expected: PASS.

---

### Task 9: Verification (orchestrator)

**Files:** none (run-only).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Static gates**

  Run: `tsc --noEmit` · `vitest run` · `bash wireframes/build.sh`
  Expected: tsc clean · vitest 75/75 suites green · build.sh clean.
  Backend drift check: `git diff --stat -- server/ shared/types.ts docs/API.md docs/SCHEMA.md` → empty.

- [ ] **Step 2: Live smokes** (`bun run dev:full`, vite :5173, server :3000; agent-browser snapshot-first, no vision)

  1. Homepage `/`: brand logo click → `/`; brand shows active state; Dashboard/Board tabs NOT active.
  2. Homepage lists all projects; each card = name + description + health dot; card without description omits the line.
  3. Card click → `/$slug` (project dashboard) with that project selected; Dashboard tab active.
  4. `/$slug`: stats bar, Column WIP, Needs Attention render; column row → `/$slug/board`; urgent/out-of-sync item → `/$slug/board?task=<id>` and the slideover opens.
  5. `/$slug/board`: board renders; `?task=` deep link opens slideover; Board tab active.
  6. Tasks page: empty-project state "Open board" → `/$slug/board`.
  7. ProjectSwitcher: on board → switches to `/$slug/board`; on dashboard → `/$slug`; on homepage → `/$slug`; "Create new project" → `/?new=1` modal opens.
  8. Empty project `/$slug` → zeros in stats, no crash; board empty state intact.
  9. Fresh-DB `/` → `/setup` redirect intact (getSetupStatus).
  10. Old URLs: `/emberfall/` (trailing slash) — verify TanStack handles it or redirects; note behavior in the report.

- [ ] **Step 3: Report**

  Paste acceptance output (tsc/vitest/build + smoke results + drift check). Flag any deviation from the spec.

---

## Self-Review Notes

- **Spec coverage:** homepage cards (T4), brand link (T5), route moves (T2/T3), retargets (T3/T7), switcher (T6), wireframes (T1), CSS (T8), verification incl. setup redirect + drift (T9) — all spec sections covered.
- **Class-name contract:** `project-cards` / `project-card` / `project-card-name` / `project-card-desc` + `nav-brand` active variant fixed in T1 and consumed by T4/T5/T8 — identical strings.
- **No placeholders:** every step has concrete commands or code; the only designer-owned freedom is visual values, which the wireframe (T1) fixes before code (T8) transcribes.
- **Known assumption:** if `NavLink` (custom) lacks a `className` prop, T5 Step 2 says wrap — verified against the component before editing.

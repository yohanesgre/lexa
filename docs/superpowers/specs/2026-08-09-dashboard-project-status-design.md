# Dashboard → Project Status View — Design

Date: 2026-08-09
Status: Approved design, pending implementation plan

## Problem

The dashboard at `/` ("Command Center") lists every project as a health card plus
cross-project aggregate stats and attention lists. For a 2-5 person team the
project list is redundant with the navbar project switcher, and "health of all
projects" is less useful than "status of the project I'm working on".

## Decision

The dashboard becomes the **status detail view of the currently selected
project**. Project switching moves entirely to the navbar switcher, which gains
a health indicator + task count per project. Backend is untouched: the existing
`GET /api/dashboard` payload already contains per-project health (WIP segments,
urgent/sync counts, task counts); the frontend scopes it by the selected slug.

**Approach A (chosen):** reuse `GET /api/dashboard`, zero backend/API/type/doc
changes. All data filtering happens client-side in `app/`. Cross-project
payload on every page is acceptable at team scale; the endpoint is cheap and
react-query caches it app-wide.

## Scope

### Dashboard page `/` — project status view

- **Header:** project name (font-display) + health dot (ok/approaching/exceeded),
  subtitle "Project status". Right side: ⋯ button opening the project settings
  modal (extracted from ProjectCard: name, description, GitHub repo, delete) and
  "New project" button.
- **Column WIP breakdown** (replaces the project-card grid): one row per column —
  column name, task count, WIP limit, state badge (ok / approaching / exceeded /
  empty) + thin progress bar vs limit. Rows link to the board `/$slug`.
- **Stats row (project-scoped):** total tasks · WIP exceeded (columns) ·
  out-of-sync tasks. Same stat-card styling as today, values from the selected
  project's health entry.
- **Needs Attention (project-scoped):** urgent tasks + out-of-sync GitHub issues
  for this project only (client-filtered by `projectSlug`). Items link to board
  + task detail as today.
- **New project flow:** header button opens CreateProjectModal directly;
  switcher "Create new project" row navigates to `/?new=1` and the dashboard
  opens the modal from the search param, then clears it.
- **Empty state:** no projects → existing dashboard-empty state (create CTA).

### Project switcher (navbar)

- Row anatomy: leading health dot (existing `health-dot-*` token colors),
  project name (primary), slug (secondary), trailing task count (font-micro,
  right-aligned).
- Picking a project from the dashboard navigates to `/`; from board/wiki pages
  rows still target `/$slug` / `/$slug/wiki` (existing routeType logic).
- Data: switcher calls `useDashboard()` (shared react-query cache), maps
  `dashboard.projects[]` → dot + count.
- States: existing loading ("Loading projects…"), empty ("No projects yet"),
  overflow (menu max-height + scroll), hover/active/focus unchanged.
- "Create new project" row → `/?new=1`.

### Removed

- ProjectCard grid, aggregate stats bar, cross-project Needs Attention.
- `app/components/ProjectCard.tsx` (settings + delete modal extracted to
  `app/components/ProjectSettingsModal.tsx`).

## Non-goals

- No new backend endpoints, no shared type changes, no API.md/SCHEMA.md edits.
- No URL restructure (board stays at `/$slug`; no `/slug/status` route).
- No cross-project visibility anywhere; the switcher is the browse surface.

## Wireframes (edit first, then code — project rule)

1. `wireframes/src/dashboard.html` → project status view per above.
2. `wireframes/src/partials/navbar.html` + `navbar-project-switcher.html` →
   expanded switcher rows.
3. `wireframes/src/flow-overview.html` + `index.html` → dashboard node
   re-described, switcher node updated.
4. `bash wireframes/build.sh` after edits; never edit `wireframes/dist/`.

## Files

- `app/routes/index.tsx` — rewrite Dashboard; add `validateSearch` for `?new=1`.
- `app/components/ProjectSettingsModal.tsx` — extracted from ProjectCard.
- `app/components/layout/ProjectSwitcher.tsx` — expanded rows + targets.
- `app/lib/queries.ts` — selector for selected project's health entry.
- Deleted: `app/components/ProjectCard.tsx`.

## Data flow

`useDashboard()` (unchanged endpoint) → react-query cache →
`index.tsx` filters `projects` by `selectedSlug` (from `useProjectSelection`,
localStorage-backed) → renders status sections. Switcher reads the same cache.
Stale/deleted selection: provider already falls back to stored → first project;
dashboard renders whatever slug is selected; no crash path.

## Error handling

- Dashboard query error → existing `dashboard-error` surface; never render the
  empty state on error.
- `?new=1` with no projects → empty state still shows (modal opens on top if a
  project exists; if empty, the empty-state CTA covers creation).
- Selection fallback chain: selectedSlug valid → stored → first project.

## Verification

- `tsc --noEmit` passes (phase gate).
- `vitest run` — no shared pure-logic changes expected.
- `bun run dev:full` + agent-browser snapshots: `/` shows selected project's
  status; switcher works from board/wiki; `?new=1` opens modal; empty state;
  stale-selection fallback; wireframe build output renders.

## Design principles applied (design skill)

- Register: product/instrument — consistency and speed; tokens only
  (PHOSPHOR CSS vars, no new hex).
- Composition from work: monitor surface — status LED hues (hue first, text
  third, per DESIGN_SYSTEM.md), scannable WIP rows, attention lists.
- All 9 states considered per component; motion stays 150-250ms ease-out.
- Copy: sentence case, verbs on buttons ("New project").

# Project Tasks List — Design

**Date:** 2026-08-09
**Status:** Approved (brainstorm, sections 1–4)

## Goal

A per-project flat task list page reachable from a new "Tasks" top-nav tab. Browse-only: scan, filter, sort, and open the existing task detail slideover. Backend untouched — the list derives from the board payload client-side (Approach A, same as the dashboard refactor).

## Approach

- **Route:** `app/routes/$slug/tasks.tsx` → `/$slug/tasks`. Tab order: Dashboard · Board · **Tasks** · Wiki · Settings · Forge.
- **Data source:** reuse `GET /api/projects/:slug/board` (full unpaginated snapshot). Zero changes to `server/`, `shared/types.ts`, `docs/API.md`, `docs/SCHEMA.md`.
- **New hook `useTasks(slug, showArchived)`** in `app/lib/queries.ts`: wraps the board query under the same query key (`["board", slug, showArchived]`) so the cache is shared with the board — no double fetch. Returns a derived flat list: each task joined with `columnName`, `swimlaneName`, priority/type label + color (from `fieldConfig`). The board keeps `useBoard` untouched; the list never reasons about columns-as-boards.
- **Detail:** `validateSearch { task?: string }`; `?task=<id>` opens the existing `TaskDetail` slideover (same component + param pattern as the board). `TaskNotFoundDialog` reused for deleted/archived races.
- **Nav plumbing:** `AppShell.routeType` gains `"tasks"` (regex `^\/[^/]+\/tasks$`); Tasks link mirrors board (`/$slug/tasks`, fallback `/`). `ProjectSwitcher.routeType` gains `"tasks"`; its board target stays `/$slug`. No other switcher changes.

## UI structure

- **Header:** "Tasks" + project name + total task count for the project (unfiltered, "42 tasks"), matching dashboard/board header conventions.
- **Filter bar:** title search (case-insensitive), column dropdown, type dropdown, priority dropdown, archived toggle. Dropdowns list only values present in the project (board.columns / fieldConfig). Intersecting filters.
- **Sort:** single active sort — Board order (columnId, position; default) · Priority (fieldConfig option order) · Newest created.
- **Rows:** title (primary, truncates), column badge, swimlane, type chip, priority chip (fieldConfig colors), GitHub link indicator (from `links`), created date. Hover highlight; click opens `?task=<id>`.
- **States:** loading skeleton rows · empty project (no tasks → empty state w/ CTA to board) · no matches (filters active → "no tasks match" + clear-filters button) · load error panel + retry.

## Edge cases

- Stale/no project selection: same redirect + needsSetup behavior as board (`getSetupStatus`).
- Archived toggle mirrors board semantics (archived excluded from counts; explicit toggle shows dimmed archived rows).
- Closing/back from detail clears `?task=` and returns to the filtered list — filters live in component state, not the URL, so they persist.
- Detail mutations update the shared board cache via `setQueryData` (invariant 6 — never `invalidateQueries` on the mutation path); the list refreshes automatically.
- Default sort = board order: tasks ordered `(columnId, position)` from the payload.

## Wireframe-first (non-negotiable)

1. Wireframe lane: new `wireframes/src/tasks.html` (list + filter bar + states), navbar partial gains the Tasks tab, `wireframes/index.html` entry, flow-overview touch. Run `bash wireframes/build.sh`; pass gate.
2. Only then the React lane: transcribe wireframe exactly, porting any new wireframe CSS classes into `app/styles/phosphor.css` (wireframe classes do not exist in the app until ported).
3. Never run wireframe work and frontend implementation in parallel.

## Verification

- Gates: `tsc --noEmit` at each gate · `vitest run` (shared pure modules, no expected changes) · `bash wireframes/build.sh` green.
- Smokes (agent-browser snapshots, no vision): Tasks tab targets `/$slug/tasks`; list renders all tasks + counts; each filter narrows; archived toggle shows dimmed archived; sort reorders; row click opens slideover with `?task=`; back clears param, filters retained; switcher on tasks page targets correct pages elsewhere; empty project → empty state; no-match → clear-filters.
- Backend untouched: `git diff --stat` against `server/`, `shared/types.ts`, `docs/*` — zero changes.

## Non-goals

- No inline edits, bulk ops, or export from the list (browse + open detail only).
- No new backend endpoint, no pagination (rejected at this scale, see REVIEW.md).
- No cross-project list (dashboard/status view covers per-project health).

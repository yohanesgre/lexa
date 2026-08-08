# Milestone Deadlines + Backlog Lane + Lane Archive — Design

**Date:** 2026-08-09
**Status:** Approved (brainstorm, sections 1–4) — viz: `docs/lexa-milestones-viz.html`

## Goal

Milestones as swimlanes with deadlines. A lane carries the milestone due date (`YYYY-MM-DD`, date-only); cards may carry an optional **earlier** personal deadline, never later than their lane's. Overdue state is visible on lane headers; moving cards into overdue lanes or conflict deadlines triggers warnings, never hard blocks. A permanent system **Backlog** lane holds unassigned work. Completed milestones are **archived** (cascade-archiving their tasks in one transaction) instead of deleted.

Decisions (user-locked, 2026-08-09): lanes = milestones/releases · visibility + move-warning (no enforcement) · optional earlier per-card deadline · warn + offer-to-clear on deadline conflict · cascade lane archive · Backlog = system lane.

## Data model

```sql
-- swimlanes additions
ALTER TABLE swimlanes ADD COLUMN due_at      TEXT;  -- YYYY-MM-DD, NULL = no deadline
ALTER TABLE swimlanes ADD COLUMN archived_at TEXT;  -- NULL = live; set = archived
ALTER TABLE swimlanes ADD COLUMN kind TEXT NOT NULL DEFAULT 'milestone'
  CHECK (kind IN ('backlog','milestone'));
-- table CHECK: a Backlog lane can never carry a deadline
CHECK (kind = 'backlog' AND due_at IS NULL OR kind = 'milestone')
-- at most one Backlog per project
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';

-- tasks additions
ALTER TABLE tasks ADD COLUMN due_at TEXT;  -- YYYY-MM-DD, NULL = none; must be <= lane due_at when lane has one
```

- **Backlog identity is `kind`, not name.** Renaming it doesn't demote it; `BACKLOG_PROTECTED` blocks archive/delete.
- **Migration (existing installs):** rename lane `'Default'` → `'Backlog'`, set `kind='backlog'`. New projects seed `Backlog` (kind=backlog, position 0 — first row) instead of `Default`.
- Board response gains `dueAt`/`archivedAt`/`kind` on swimlanes, `dueAt` on tasks. Columns untouched. No GitHub sync for deadlines (column→`github_state` mapping unchanged).

## API

- `POST /api/projects/:slug/swimlanes` body gains `dueAt?` (rejected on backlog kind — server sets kind, clients never pass it). `PATCH .../swimlanes/:id` gains `dueAt?`; setting a lane `dueAt` earlier than any live card's `due_at` in that lane → `409 DEADLINE_AFTER_LANE` (details: lane date + first offending card id).
- `POST /api/projects/:slug/tasks` body: `swimlaneId` becomes **optional** → defaults to the project's Backlog lane (was required). Body gains `dueAt?`.
- `PATCH /api/projects/:slug/tasks/:id/move` gains `clearDueAt?: true` — clears the card's `due_at` in the **same atomic UPDATE** as the move (no two-call window). If a card with `due_at` moves into a lane whose `due_at` is earlier and `clearDueAt` is absent → `409 DEADLINE_AFTER_LANE` (details: lane date).
- `POST /api/projects/:slug/swimlanes/:id/archive` → **one transaction**: lane `archived_at` set + every live task in the lane archived (per-task `archived` activity rows, existing emission). Idempotent. Returns `{ data: Swimlane, activity }`. Rejected on backlog kind → `409 BACKLOG_PROTECTED`.
- `POST /api/projects/:slug/swimlanes/:id/restore` → lane only; tasks stay archived (restore individually, same as today). Idempotent.
- `GET .../board?includeArchived=true` brings back archived lanes (same pattern as tasks).
- **Card deadline rule:** `tasks.due_at <= lane.due_at` when the lane has one; enforced in service on create/update/move (SQLite CHECK can't reach across tables). Backlog has no `due_at` → cards there may carry any date.

## MCP

- `update_swimlane` gains `dueAt?`; `create_task`/`update_task` gain `dueAt?` and `swimlane` becomes optional (defaults to Backlog); list/get responses include `dueAt`.
- New admin tools `archive_swimlane` / `restore_swimlane` (by name, mirroring `archive_task`/`restore_task`); archive of Backlog → `BACKLOG_PROTECTED`.
- Move/create targeting an archived lane name → not-found-style error with `details.available*` (archived lanes are not valid targets).

## Board UI (wireframe-first — `wireframes/src/*.html` + build gate before any React)

- **Lane header:** due chip "Due Fri" + countdown "3d left"; past due → red chip "Overdue 2d" + red lane border (PHOSPHOR tokens). Backlog rendered first, muted, no due chip, no archive action.
- **Card:** small deadline chip **only when the card has its own** deadline (red when past). Inherited lane date lives on the lane header, never on the card.
- **Move dialog:** target lane overdue → confirm "Lane v1.0 is overdue (2d). Move anyway?" (move allowed). Card deadline > target lane due → warning + checkbox "Clear card deadline (Fri → none)" → sends `clearDueAt: true`.
- **Archive/restore:** lane header Archive action (milestone lanes only); archived lanes shown in an archived section/settings view with Restore.
- Tasks list view (`?view=list`) shows the same card deadline chip.

## Activity feed

- Card `due_at` set/cleared → `field_changed` emission (new `due_at` message added to the catalog in `server/activity-messages.ts`, frozen at write time — invariant 13).
- Lane archive cascade emits per-task `archived` rows (existing message). Lane deadline changes emit nothing (swimlane mutations have no activity today — kept).

## Edge cases

- Two Backlogs impossible (partial unique index). Archiving the last milestone lane is fine — Backlog remains, board never empty.
- Moving a card with deadline out of Backlog into a milestone due sooner → conflict warning + clear checkbox (same rule; Backlog is the no-rule exception).
- Archived lanes: no overdue styling (deadline becomes history), not valid move targets.
- Idempotency: re-archive/re-restore returns unchanged (mirrors task archive semantics).

## Wireframe-first (non-negotiable)

1. Wireframe lane: edit `wireframes/src/` (board swimlane header states, card deadline chip, move dialog states, archived section, Backlog lane) + annotation notes; run `bash wireframes/build.sh`; pass gate.
2. Only then the React lane: transcribe exactly, porting new wireframe CSS classes into `app/styles/phosphor.css`.
3. Never run wireframe work and frontend implementation in parallel.

## Docs to update (authority order)

SCHEMA.md (columns + CHECKs + index), LAYERS.md (error catalog: `DEADLINE_AFTER_LANE`, `BACKLOG_PROTECTED`), API.md (endpoints, payloads, error map), MCP.md (tool shapes), `docs/DESIGN_SYSTEM.md` only if new tokens appear.

## Verification

- Gates: `tsc --noEmit` · `vitest run` (move/clear atomicity, deadline guards, backlog protection, cascade tx) · `bash wireframes/build.sh` green.
- Live smokes (agent-browser, no vision): lane due chip + countdown + overdue state; card deadline chip (own only); move into overdue lane → confirm; conflict move → checkbox clears deadline in one call (verify no interim state); archive lane → all tasks archived in one tx (activity rows present); restore lane → tasks still archived; create task without swimlane → lands in Backlog; Board `includeArchived` shows archived lanes; MCP round-trip (create task w/ dueAt, archive lane by name, BACKLOG_PROTECTED on Backlog archive).
- Round-trip scripted against dev DB (`emberfall` project).

## Non-goals

- No roadmap/timeline view, no project-level deadline, no reminders/notifications.
- No deadline sync to GitHub (column→`github_state` untouched).
- No time-of-day; dates only.
- No hard enforcement — deadlines inform, humans decide.

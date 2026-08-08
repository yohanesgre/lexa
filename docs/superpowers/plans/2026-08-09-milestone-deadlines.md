# Milestone Deadlines + Backlog Lane + Lane Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swimlanes become milestones: lanes carry a due date (`due_at`), cards may carry an earlier personal deadline (`due_at`, never later than their lane's), a permanent system **Backlog** lane holds unassigned work, and completed milestones are archived (cascade-archiving their tasks in one transaction).

**Architecture:** One migration adds `swimlanes.due_at/archived_at/kind` + `tasks.due_at` (partial unique index guarantees one Backlog per project; cross-column CHECK is impossible via SQLite ALTER — service-enforced instead, declared deviation). Swimlane service gains archive/restore + deadline guards; task service gains optional-swimlane→Backlog default, `dueAt` on create/update, and `clearDueAt` in the atomic move. REST + MCP expose the new fields and tools; board UI shows lane due chips/countdown/overdue, card deadline chips, move-confirm dialogs, and an archived-lanes section. Wireframe-first: the wireframe lane completes before any React lane.

**Tech Stack:** Bun · SQLite (bun:sqlite) · Effect-TS (services/repos, tagged errors) · @effect/platform HttpApi · TanStack Query · @dnd-kit · React · Tailwind/PHOSPHOR CSS vars.

## Global Constraints

- **Wireframe-first (non-negotiable):** Task 1 (wireframes) MUST complete and pass its gate before any React task. Never run wireframe work and frontend implementation in parallel.
- **Names exact (non-negotiable):** columns `swimlanes.due_at`, `swimlanes.archived_at`, `swimlanes.kind` (`'backlog'|'milestone'`), `tasks.due_at`; error codes `DEADLINE_AFTER_LANE`, `BACKLOG_PROTECTED`; API paths `POST/DELETE .../swimlanes/:id/archive|restore`; MCP tools `archive_swimlane`, `restore_swimlane`. Wire field names: `dueAt`, `archivedAt`, `kind`, `clearDueAt`.
- **Invariant 6:** mutation responses authoritative — `setQueryData` only, never `invalidateQueries` in mutation paths. Board cache keys `["board", slug, false]` AND `["board", slug, true]` both updated on task/lane mutations.
- **Invariant 13:** activity rows in the SAME tx as the mutation, messages from `server/activity-messages.ts` only (new `dueAt` variant added there — never hand-rolled at call sites).
- **Invariant 10:** column→GitHub mapping untouched; deadlines never sync to GitHub. Move handler's best-effort GitHub sync unchanged.
- **Backlog rules:** `kind='backlog'` lane is permanent — archive/delete/dueAt all rejected (`BACKLOG_PROTECTED`); identity is kind, not name.
- **Deviations to declare to user:** (1) spec's cross-column CHECK `(kind='backlog' AND due_at IS NULL OR kind='milestone')` is NOT in the migration — SQLite `ALTER TABLE ADD COLUMN` cannot add table CHECKs; enforced in SwimlaneService instead. (2) MCP `move_task` keeps its current shape (no swimlane arg — out of scope). (3) Existing projects with a lane already renamed away from `'Default'` get a backfilled Backlog at the end of their lane order (position ties are harmless — no UNIQUE on position).
- **No commits during execution** (project rule: commits only on explicit user ask). Gates are `tsc --noEmit` / `vitest run` / `bash wireframes/build.sh` / live smokes. Single commit at the end on user approval.
- TypeScript strict; no `any` outside JSON-payload boundaries. PHOSPHOR tokens only — no raw hex outside `phosphor.css`. `shared/types.ts` is read-only for designer; modified by server-lane tasks only.
- Backend pattern: repos thin (prepared statements, no business logic), services map repo errors → domain errors from the catalog (`server/api/errors.ts`), `updated_at = datetime('now')` in every UPDATE.

---

### Task 1: Wireframe lane — milestone lanes, due chips, dialogs, archived section (designer)

**Files:**
- Modify: `wireframes/src/kanban.html`, `wireframes/src/partials/_swimlane-header-expanded.html`, `wireframes/src/partials/_swimlane-header-collapsed.html`, `wireframes/src/wireframes.css`, `wireframes/src/kanban-swimlane-settings-modal.html`
- Create: `wireframes/src/partials/_lane-due-chip.html` (if cleaner as partial), `wireframes/src/kanban-move-dialog.html` (move-confirm dialog states)
- Run: `bash wireframes/build.sh` (cwd `wireframes/`)

**Interfaces:**
- Produces: the canonical class names + markup for: lane due chip (`.lane-due`, `.lane-due-overdue`, countdown text), card deadline chip (`.card-due`, `.card-due-overdue`), archived lane row (`.swimlane-archived` + restore action), Backlog lane header (no due chip, no archive action, `.swimlane-backlog`), move dialog (`.dialog` + `.check-row` + buttons), swimlane settings form due-date input (`input[type="date"]`). All decisions as visible annotation notes (`.annotation`/`.annotation-tag` — wireframes rule).

**Steps** (annotate every new state; match existing house geometry — see `docs/lexa-milestones-viz.html` produced earlier for the target visuals):

- [ ] **Step 1: Lane headers.** Update `partials/_swimlane-header-expanded.html` and `_swimlane-header-collapsed.html`: add due chip `<span class="lane-due">Due Fri · 3d left</span>` after the count, an overdue variant `<span class="lane-due lane-due-overdue">Overdue 2d</span>`, and a Backlog variant (`.swimlane-backlog` — muted, no due chip, no archive). Add annotation tags: "lane due date = milestone deadline (YYYY-MM-DD, date-only)"; "overdue = red state, lane header only — enforcement is advisory"; "Backlog = system lane: permanent, no deadline, archive disabled".
- [ ] **Step 2: Card deadline chip.** In `kanban.html` card markup add `<span class="card-due">Due Tue</span>` (card-meta row) + past-due variant `.card-due-overdue` (red). Annotate: "card shows its OWN deadline only (optional, never later than the lane's); lane deadline lives on the lane header, never on cards"; "cards in Backlog may carry any deadline".
- [ ] **Step 3: Move-confirm dialog states.** Create `kanban-move-dialog.html` with two states: (a) overdue-lane: "Lane v1.0 is overdue (2d). Move anyway?" [Move] [Cancel]; (b) conflict: "Card due Fri is later than lane due Wed" + checkbox row `.check-row` "Clear card deadline (Fri → none)" + [Move] [Cancel]. Annotate: "conflict move sends clearDueAt in the SAME atomic move; without the flag the server returns 409 DEADLINE_AFTER_LANE".
- [ ] **Step 4: Archived lanes section.** In `kanban.html` add a bottom muted section: archived lane row (`.swimlane-archived` — dimmed header + "Restore" button). Annotate: "archiving a lane archives its live tasks in one transaction; restore brings the lane back only — tasks restore individually".
- [ ] **Step 5: Settings form date input.** In `kanban-swimlane-settings-modal.html` add `Due date` field: `input type="date"` + helper "YYYY-MM-DD — milestone deadline"; Backlog variant shows no date field (annotation: "Backlog can never carry a deadline").
- [ ] **Step 6: CSS + build gate.** Add `.lane-due`, `.lane-due-overdue`, `.card-due`, `.card-due-overdue`, `.swimlane-backlog`, `.swimlane-archived`, `.check-row` rules to `wireframes/src/wireframes.css` using PHOSPHOR tokens (`--lx-text-danger`, `--lx-bg-danger`, `--lx-text-warning`, `--lx-border-subtle`, etc. — mirror existing chip patterns like `.wip-badge`/`.history-badge`). Run `bash wireframes/build.sh` (cwd `wireframes/`) — exit 0. Confirm `wireframes/dist/kanban.html` + partials contain the new markup.

**Gate:** `bash wireframes/build.sh` exit 0; grep dist for `.lane-due`, `.card-due`, `.swimlane-archived`, `.check-row` — all present. No other files touched.

---

### Task 2: Migration + shared types + row mappers + error catalog (fixer — server lane)

**Files:**
- Create: `migrations/0005_milestone_deadlines.sql`
- Modify: `shared/types.ts` (Swimlane ~26-32, Task ~64-79), `shared/db.ts` (`SwimlaneRow` ~83-89, `rowToSwimlane` ~91-101, `rowToTask`/`TASK_SELECT`), `server/api/errors.ts` (error classes ~5-50, `errorCodeMap` ~52-105, `errorToStatus` ~107-173, `errorMessage` ~175-288), `server/activity-messages.ts` (factory fn + `formatActivityMessage` field_changed case ~50-66), `scripts/seed-dev.sql:127-129`, `server/services/project.service.ts:51-56`

**Interfaces:**
- Consumes: migration runner `server/db/migrate.ts` (lexicographic `migrations/*.sql`); error catalog patterns from `server/api/errors.ts` (tagged errors `Data.TaggedError`, `errorCodeMap` entries `{ httpStatus, code }`).
- Produces: `Swimlane` type `{ ..., dueAt: string | null; archivedAt: string | null; kind: "backlog" | "milestone" }`; `Task` type `{ ..., dueAt: string | null }`; `SwimlaneRow` + `rowToSwimlane` mapping the three new columns; `TASK_SELECT`/`rowToTask` mapping `due_at`; errors `DeadlineAfterLane` (409) + `BacklogProtected` (409) with `errorCodeMap`/`errorToStatus`/`errorMessage` entries; activity message `dueDateChanged(from: string | null, to: string | null)` + `field_changed` variant `"dueAt"`.

- [ ] **Step 1: Migration.** Create `migrations/0005_milestone_deadlines.sql`:
```sql
-- Milestone deadlines: swimlane due date + kind, lane/task archive + card deadlines.
ALTER TABLE swimlanes ADD COLUMN due_at TEXT;  -- YYYY-MM-DD, NULL = no deadline
ALTER TABLE swimlanes ADD COLUMN archived_at TEXT;  -- NULL = live
ALTER TABLE swimlanes ADD COLUMN kind TEXT NOT NULL DEFAULT 'milestone'
  CHECK (kind IN ('backlog','milestone'));
CREATE UNIQUE INDEX idx_swimlanes_one_backlog ON swimlanes(project_id) WHERE kind = 'backlog';
ALTER TABLE tasks ADD COLUMN due_at TEXT;  -- YYYY-MM-DD, NULL = none; <= lane due_at

-- Existing 'Default' lanes become the system Backlog lane (identity = kind, not name).
UPDATE swimlanes SET name = 'Backlog', kind = 'backlog' WHERE name = 'Default';

-- Projects without a Backlog lane (lane renamed historically) get one at the end.
INSERT INTO swimlanes (id, project_id, name, description, position, kind)
SELECT 'bl-' || substr(id, 1, 8) || '-' || hex(randomblob(4)), id, 'Backlog', '',
       (SELECT COALESCE(MAX(position), -1) + 1 FROM swimlanes s WHERE s.project_id = p.id), 'backlog'
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM swimlanes s2 WHERE s2.project_id = p.id AND s2.kind = 'backlog');
```
Note: cross-column CHECK `(kind='backlog' AND due_at IS NULL OR kind='milestone')` is deliberately omitted — SQLite ALTER TABLE cannot add table-level CHECKs; SwimlaneService enforces it (Task 3). Declare this deviation in the final report.

- [ ] **Step 2: Shared types.** `shared/types.ts`:
```ts
export interface Swimlane {
  id: ID; projectId: ID; name: string; description: string; position: number;
  dueAt: string | null; archivedAt: string | null; kind: "backlog" | "milestone";
}
// Task gains:
  dueAt: string | null;
```
- [ ] **Step 3: Row mappers.** `shared/db.ts`: extend `SwimlaneRow` (`due_at`, `archived_at`, `kind` — note `kind` may be absent on rows from pre-migration code paths; use `?? "milestone"` default in mapper for safety) and `rowToSwimlane` (map `dueAt: row.due_at`, `archivedAt: row.archived_at`, `kind: (row.kind ?? "milestone") as Swimlane["kind"]`). Extend `TASK_SELECT` with `t.due_at` and `rowToTask` with `dueAt: row.due_at`.
- [ ] **Step 4: Error catalog.** `server/api/errors.ts` — add after the existing classes:
```ts
export class DeadlineAfterLane extends Data.TaggedError("DeadlineAfterLane")<{
  date: string;                    // the lane's due date (YYYY-MM-DD)
  taskId?: string;                 // first offending task (lane-shrink path)
}> {}

export class BacklogProtected extends Data.TaggedError("BacklogProtected")<{
  action: "archive" | "delete" | "deadline";
}> {}
```
`errorCodeMap`: `DeadlineAfterLane: { httpStatus: 409, code: "DEADLINE_AFTER_LANE" }`, `BacklogProtected: { httpStatus: 409, code: "BACKLOG_PROTECTED" }`. `errorToStatus`: `DeadlineAfterLane` → 409, `BacklogProtected` → 409. `errorMessage`: `DeadlineAfterLane` → `Task deadline cannot be later than the lane's (lane due ${e.date})`, `BacklogProtected` → `The Backlog lane is protected (${e.action} not allowed)`. Follow the exact existing pattern (check how `WipLimitExceeded` is wired and mirror it).
- [ ] **Step 5: Activity message.** `server/activity-messages.ts`:
```ts
export function dueDateChanged(from: string | null, to: string | null) {
  return to === null ? "Due date cleared" : from === null ? `Due date set: ${to}` : `Due date changed: ${from} → ${to}`;
}
```
In `formatActivityMessage` field_changed case: extend variant union to `"title" | "description" | "assignees" | "priority" | "type" | "dueAt"` and add `case "dueAt": return dueDateChanged(p.from ?? null, p.to ?? null);` (payload `from`/`to` are the date strings or null).
- [ ] **Step 6: Seeds.** `scripts/seed-dev.sql:127-129`: change to `INSERT INTO swimlanes (id, project_id, name, description, position, kind) VALUES ('seed-sw-min-0', 'seed-proj-minimal', 'Backlog', '', 0, 'backlog');`. `server/services/project.service.ts:51-56`: new-project lane becomes `name: "Backlog"`, `position: 0`, `kind: "backlog"` (repo.create gains `kind` in Task 3 — wire it here in Task 3's step if ordering bites; the service call must match the repo signature by the end of Task 3).
- [ ] **Step 7: Gate.** `npx tsc --noEmit` — clean. `bun run dev:server` boot smoke: `curl http://localhost:3000/api/health` → `{"ok":true}` and the dev DB has a `Backlog` lane (`sqlite3 data/lexa.db "SELECT name, kind FROM swimlanes WHERE kind='backlog'"`).

**Gate:** tsc clean; migration applies to a fresh DB (delete `data/lexa.db*`, `bun run setup --yes` or run migrations) and to the existing dev DB; `SELECT count(*) FROM swimlanes WHERE kind='backlog'` ≥ 1 per project.

---

### Task 3: Swimlane repo + service — dueAt, kind, archive/restore, guards (fixer — server lane)

**Files:**
- Modify: `server/repos/swimlane.repo.ts`, `server/services/swimlane.service.ts`, `server/services/project.service.ts` (finish wiring `kind` at create)

**Interfaces:**
- Consumes: `Swimlane`/`SwimlaneRow` from Task 2; errors `BacklogProtected`, `DeadlineAfterLane`, `SwimlaneNotFound`, `HasChildren`, `TaskNotFound` from `server/api/errors.ts`; `withTx` from `server/db/database.ts`; `TaskRepo.findBySwimlane` from Task 4 (archive cascade needs live task ids — repo method added in Task 4; to keep task 3 self-contained, archive cascade lives in Task 4's service change OR Task 3 defines `archive` calling `taskRepo.findBySwimlane` — ordering note: implement `findBySwimlane` in Task 4 step 1, then Task 3's archive body wires to it; tasks must be merged into one lane).
- Produces: repo methods `create` (+`kind` input), `update` (+`dueAt`), `findBacklog(projectId)`, `setArchived(id, archivedAt | null)`, `countDueAfter(swimlaneId, dueAt)`; service methods `create` (+`dueAt`, kind forced `'milestone'` for client creates), `update` (+`dueAt` with guards), `archive(actor, id)`, `restore(actor, id)` with cascade semantics.

- [ ] **Step 1: Repo create/update gain dueAt + kind.**
```ts
create: (input: { id; projectId; name; description?: string; position: number; kind?: "backlog" | "milestone"; dueAt?: string | null }) =>
  // INSERT INTO swimlanes (id, project_id, name, description, position, kind, due_at)
  // VALUES (?, ?, ?, ?, ?, ?, ?)   — kind defaults 'milestone', due_at NULL
update: (id, input: { name?; description?; position?; dueAt?: string | null }) =>
  // dynamic SET builder gains: if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }
```
`findByProject` stays `SELECT * ... ORDER BY position` (all lanes incl. archived; filtering happens in the service).
- [ ] **Step 2: New repo methods.**
```ts
findBacklog: (projectId: string): Effect.Effect<Swimlane, RowNotFound | DbError> =>
  queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE project_id = ? AND kind = 'backlog'`, projectId)
    .pipe(Effect.map(rowToSwimlane)),

setArchived: (id: string, archivedAt: string | null): Effect.Effect<Swimlane, RowNotFound | DbError> =>
  run(db, `UPDATE swimlanes SET archived_at = ?, updated_at?`, ...)  // NOTE: swimlanes has NO updated_at column — plain UPDATE swimlanes SET archived_at = ? WHERE id = ?
    .pipe(Effect.flatMap(() => queryFirst<SwimlaneRow>(db, `SELECT * FROM swimlanes WHERE id = ?`, id)))
    .pipe(Effect.map(rowToSwimlane)),

countDueAfter: (swimlaneId: string, dueAt: string): Effect.Effect<number, DbError> =>
  queryAll<{ c: number }>(db,
    `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ? AND due_at IS NOT NULL AND due_at > ? AND archived_at IS NULL`,
    swimlaneId, dueAt).pipe(Effect.map((rows) => rows[0]?.c ?? 0)),
```
- [ ] **Step 3: Service create/update guards.** In `swimlane.service.ts`:
- `create`: accept `{ projectId, name, description?, dueAt? }`; pass `kind: "milestone"` to repo (clients can never create Backlog lanes); reject `dueAt` non-null without format check (server stores as-is — client sends `YYYY-MM-DD`).
- `update`: after fetching current lane (guard BEFORE repo.update): if `lane.kind === "backlog"` and `input.dueAt !== undefined` → `new BacklogProtected({ action: "deadline" })`. If `input.dueAt !== undefined && input.dueAt !== null`: fetch lane's live-task overage via `repo.countDueAfter(id, input.dueAt)`; if `> 0` → `new DeadlineAfterLane({ date: input.dueAt })`. Pass `dueAt` through.
- [ ] **Step 4: Service archive/restore (cascade).**
```ts
archive: (actor: Actor, id: string): Effect.Effect<{ lane: Swimlane; activity: ActivityEvent[] },
    SwimlaneNotFound | BacklogProtected | TaskNotFound | DbError | ConstraintViolation> =>
  Effect.gen(function* () {
    const lane = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
    if (lane.kind === "backlog") return yield* new BacklogProtected({ action: "archive" });
    if (lane.archivedAt) return { lane, activity: [] };   // idempotent
    const done = yield* withTx(db, Effect.gen(function* () {
      const a = yield* repo.setArchived(id, new Date().toISOString());
      const tasks = yield* taskRepo.findBySwimlane(id);   // Task 4 step 1 — live tasks in lane
      const events: ActivityEvent[] = [];
      for (const t of tasks) {
        yield* taskRepo.setArchived(t.id, a.archivedAt ?? new Date().toISOString());
        events.push(yield* activityService.append(t.id, actor, "archived", msg.archived(actor.label)));
      }
      return { lane: a, activity: events };
    }));
    yield* Effect.logInfo(`[Swimlane] Archived ${done.lane.id} with ${done.activity.length} tasks`);
    return done;
  }),

restore: (actor: Actor, id: string): Effect.Effect<{ lane: Swimlane; activity: ActivityEvent[] },
    SwimlaneNotFound | DbError> =>
  // lane only: setArchived(id, null); NO task changes. Idempotent (archivedAt null → return unchanged).
```
Dependencies: add `TaskRepo` + `ActivityService` to the service's `dependencies: [...]`. `restore` needs `Actor` type import; cascade archive's task activity reuses existing `archived` message (invariant 13 — same tx).
- [ ] **Step 5: project.service.ts create wiring.** Pass `kind: "backlog"` in the new-project lane `swimlaneRepo.create({ ... name: "Backlog", kind: "backlog" })` (matches new repo signature).
- [ ] **Step 6: Gate.** `npx tsc --noEmit` — clean. Unit-level check via existing test harness if any swimlane tests exist (`rg -l "SwimlaneService|swimlane.service" server --glob "*.test.ts"`); if present, update fixtures (Default→Backlog name/kind) and run `bun run vitest run server/...`.

**Gate:** tsc clean; existing swimlane tests (if any) pass with updated fixtures.

---

### Task 4: Task repo + service — dueAt, Backlog default, clearDueAt, deadline guards (fixer — server lane)

**Files:**
- Modify: `server/repos/task.repo.ts` (create ~41-96, update ~199-253, move ~315-359, add `findBySwimlane`, `findLiveTasksDueAfter`), `server/services/task.service.ts` (create ~94, update ~225, move ~299, `MoveTarget` ~513-518), `server/repos/task.repo.ts` TASK_SELECT usage

**Interfaces:**
- Consumes: `SwimlaneRepo.findBacklog` (Task 3), `Swimlane` type (Task 2), errors `DeadlineAfterLane`, `SwimlaneNotFound` (existing), `TaskNotFound`, `DbError`.
- Produces: `task.repo.create` accepts `dueAt?: string | null` (INSERT + re-select include `t.due_at`); `task.repo.update` accepts `dueAt?: string | null` (dynamic SET `due_at = ?`); `task.repo.move` target gains `clearDueAt?: boolean` — when true, `UPDATE ... SET column_id=?, swimlane_id=?, position=?, due_at = CASE WHEN due_at IS NOT NULL AND due_at > (SELECT due_at FROM swimlanes WHERE id = ?) THEN NULL ELSE due_at END, updated_at=datetime('now')` — actually simpler: when `clearDueAt` true, SET `due_at = NULL` in the same UPDATE (client checked the box). When false/absent: normal UPDATE; the SERVICE enforces the deadline guard BEFORE calling repo.move and returns `DeadlineAfterLane`; `task.repo.findBySwimlane(swimlaneId)` → `Task[]` (live only); `task.repo.findLiveTasksDueAfter(swimlaneId, dueAt)` → `Task[]` (for lane-shrink; Task 3 uses countDueAfter — keep only countDueAfter in repo, drop findLiveTasksDueAfter to avoid dead code; the lane shrink only needs a count + first id → extend `countDueAfter` to also return first id or keep count-only and add `firstTaskIdDueAfter`).
- Service: `create` accepts `swimlaneId?: string | null` → resolves to `repo.findBacklog(projectId)` when absent (error `SwimlaneNotFound` with `availableSwimlanes` if no backlog — should not happen post-migration); validates `dueAt <= lane.dueAt` when lane has one → `DeadlineAfterLane({ date: lane.dueAt })`; `update` validates same against current lane; `move` validates target lane deadline vs task's current `dueAt` unless `clearDueAt` — else `DeadlineAfterLane({ date: targetLane.dueAt })`; `MoveTarget` gains `clearDueAt?: boolean`; move passes `clearDueAt` to repo.move.

- [ ] **Step 1: Repo findBySwimlane + dueAt plumbing.**
```ts
findBySwimlane: (swimlaneId: string): Effect.Effect<Task[], DbError> =>
  queryAll<TaskRow>(db, `SELECT ${TASK_SELECT_COLS} FROM tasks t WHERE t.swimlane_id = ? AND t.archived_at IS NULL ORDER BY t.position, t.id`, swimlaneId)
    .pipe(Effect.map((rows) => rows.map(rowToTask))),
```
Create: `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` (due_at null → `null` param). Update dynamic builder: `if (input.dueAt !== undefined) { sets.push("due_at = ?"); params.push(input.dueAt); }`. Both re-select via TASK_SELECT (must include `t.due_at` — done in Task 2).
- [ ] **Step 2: Repo move gains clearDueAt.** In `move` (both WIP-guarded and bypassWip variants): when `target.clearDueAt === true` append `, due_at = NULL` to the SET list. Keep the WIP conditional untouched (invariant 5).
- [ ] **Step 3: Service create — Backlog default + guard.**
```ts
// inside create, replacing the swimlaneId validation block:
const lane = input.swimlaneId
  ? yield* swimlaneRepo.findById(input.swimlaneId).pipe(
      Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: input.swimlaneId })))
  : yield* swimlaneRepo.findBacklog(project.id).pipe(
      Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: "backlog", availableSwimlanes: [] })));
if (lane.projectId !== project.id) return yield* new SwimlaneNotFound({ id: input.swimlaneId ?? "backlog" });
if (lane.archivedAt) return yield* new SwimlaneNotFound({ id: lane.id, availableSwimlanes: [] });  // archived lanes not valid targets
if (input.dueAt && lane.dueAt && input.dueAt > lane.dueAt)
  return yield* new DeadlineAfterLane({ date: lane.dueAt });
```
(`input.swimlaneId` becomes optional in the create input type; subtask inheritance keeps parent's lane — unchanged.)
- [ ] **Step 4: Service update guard.** After resolving the task + its lane: if `input.dueAt` set and lane has `dueAt` and `input.dueAt > lane.dueAt` → `DeadlineAfterLane({ date: lane.dueAt })`. Pass `dueAt` into repo.update. On `dueAt` change (from≠to), emit a `field_changed` activity event with variant `"dueAt"`, `from: previous ?? null`, `to: next ?? null` — same tx (invariant 13). No event when unchanged.
- [ ] **Step 5: Service move guard + clearDueAt.**
```ts
// before repo.move, when task has a due date:
const targetLane = yield* swimlaneRepo.findById(target.swimlaneId).pipe(
  Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: target.swimlaneId })));
if (targetLane.projectId !== project.id) return yield* new SwimlaneNotFound({ id: target.swimlaneId });
if (targetLane.archivedAt) return yield* new SwimlaneNotFound({ id: target.swimlaneId, availableSwimlanes: [] });
if (task.dueAt && targetLane.dueAt && task.dueAt > targetLane.dueAt && !target.clearDueAt)
  return yield* new DeadlineAfterLane({ date: targetLane.dueAt });
// pass through: repo.move(taskId, { ...target, clearDueAt: target.clearDueAt ?? false })
```
Note the existing move already validates the target lane (cross-project) — extend that block rather than duplicating. `MoveTarget` type gains `clearDueAt?: boolean`.
- [ ] **Step 6: Gate.** `npx tsc --noEmit` — clean. If task service tests exist (`server/**/*.test.ts` with task fixtures), update fixture INSERTs (due_at NULL fine — no change needed unless asserting columns) and run `bun run vitest run server`.

**Gate:** tsc clean; vitest green (existing suite; no new tests required — smoke round-trip in final task covers behavior).

---

### Task 5: HTTP API — schemas, endpoints, board includeArchived (fixer — server lane)

**Files:**
- Modify: `server/api/http.ts` (SwimlaneSchema ~201-207, SwimlanePayload ~211-215, TaskSchema ~829-844, CreateTaskPayload ~856-865, MoveTaskPayload ~875-880, swimlanesGroup ~810-818, swimlanesLive ~1336-1377, tasks group handlers ~1891-2082, boardLive getBoard ~2084-2110, formatSwimlane ~2366-2368)

**Interfaces:**
- Consumes: service methods from Tasks 3-4, error catalog from Task 2.
- Produces: REST contract: `Swimlane` wire shape with `dueAt/archivedAt/kind`; `Task` wire shape with `dueAt`; `POST /api/projects/:slug/swimlanes` body `{ name*, description?, position?, dueAt? }`; `PATCH .../swimlanes/:id` same optional fields; `POST /api/projects/:slug/swimlanes/:id/archive` → `200 { data: Swimlane, activity: ActivityEvent[] } | 404 | 409 BACKLOG_PROTECTED`; `POST .../restore` → same; `POST /api/projects/:slug/tasks` body `{ columnId*, swimlaneId?, title*, description?, priority?, type?, parentId?, assignees?, dueAt? }`; `PATCH /tasks/:id` gains `dueAt?`; `POST /tasks/:id/move` body gains `clearDueAt?`; `GET /board?includeArchived=true` includes archived lanes (tasks already filtered there).

- [ ] **Step 1: Swimlane schemas.**
```ts
const SwimlaneSchema = Schema.Struct({
  id: Schema.String, projectId: Schema.String, name: Schema.String,
  description: Schema.String, position: Schema.Number,
  dueAt: Schema.NullOr(Schema.String), archivedAt: Schema.NullOr(Schema.String),
  kind: Schema.Literal("backlog", "milestone"),
});
const SwimlanePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
});
```
- [ ] **Step 2: Task schemas.** `TaskSchema` gains `dueAt: Schema.NullOr(Schema.String)` after `archivedAt`. `CreateTaskPayload.swimlaneId` becomes `Schema.optional(Schema.String)`; add `dueAt: Schema.optional(Schema.NullOr(Schema.String))`. `MoveTaskPayload` gains `clearDueAt: Schema.optional(Schema.Boolean)`.
- [ ] **Step 3: Archive/restore endpoints.** In `swimlanesGroup`:
```ts
.add(HttpApiEndpoint.post("archiveSwimlane", "/projects/:slug/swimlanes/:id/archive")
  .setPath(SwimlanePath).addSuccess(SwimlaneMutationResponse))
.add(HttpApiEndpoint.post("restoreSwimlane", "/projects/:slug/swimlanes/:id/restore")
  .setPath(SwimlanePath).addSuccess(SwimlaneMutationResponse))
```
with `const SwimlaneMutationResponse = Schema.Struct({ data: SwimlaneSchema, activity: Schema.Array(ActivityEventSchema) });` (place next to `TaskMutationResponse` ~851). Handlers in `swimlanesLive` (admin-gated like the others):
```ts
handlers.handle("archiveSwimlane", (req) =>
  respond(Effect.gen(function* () {
    yield* requireAdmin;  // match existing admin guard pattern in this group
    const service = yield* SwimlaneService;
    const actor = yield* currentActor();   // match how task handlers build Actor
    const result = yield* service.archive(actor, req.path.id);
    return { data: formatSwimlane(result.lane), activity: result.activity };
  }))),
```
(`restoreSwimlane` mirrors with `service.restore`.) Check how the existing swimlane handlers obtain the admin identity + how task handlers build `Actor` (actor extraction pattern exists for tasks) and reuse it.
- [ ] **Step 4: Board includes archived lanes.** `boardLive getBoard` (~2095): `const swimlanes = yield* swimlaneService.findByProject(project.id, { includeArchived });` — extend `swimlane.service.findByProject` (Task 3) with optional `{ includeArchived?: boolean }` filtering `archived_at IS NULL` when false (default false for the settings list too — check `listSwimlanes` handler ~1343: settings list should show archived lanes in the archived section, so `findByProject` default = include archived? Decide: `listSwimlanes` (settings) passes `{ includeArchived: true }`; board passes the query param. Keep service default `includeArchived: false` and update BOTH call sites explicitly.)
- [ ] **Step 5: formatSwimlane.** Stays identity cast (row → type now carries new fields) — verify `formatTask` too (identity cast: fine). Ensure `TASK_SELECT` includes `due_at` so formatted tasks carry it.
- [ ] **Step 6: Gate.** `npx tsc --noEmit` — clean. Boot `bun run dev:server`, then:
```bash
curl -s http://localhost:3000/api/projects/emberfall/board | python3 -m json.tool | grep -A2 '"kind"'   # lanes carry kind
curl -s http://localhost:3000/api/projects/emberfall/swimlanes | python3 -m json.tool | grep '"dueAt"'
```

**Gate:** tsc clean; live curl shows `kind`/`dueAt` on lanes + `dueAt` on tasks.

---

### Task 6: MCP — dueAt inputs, optional swimlane, archive/restore tools (fixer — server lane)

**Files:**
- Modify: `server/mcp/tools/create-task.ts` (inputSchema ~14-27, handler, TaskSummary ~91-109), `server/mcp/tools/update-task.ts`, `server/mcp/tools/update-swimlane.ts` (inputSchema ~8-17), `server/mcp/tools/create-swimlane.ts` (dueAt passthrough), `server/mcp/server.ts` (tools list ~74-112 — add 2), `server/mcp/server.test.ts:76-79` (37 → 39)
- Create: `server/mcp/tools/archive-swimlane.ts`, `server/mcp/tools/restore-swimlane.ts`

**Interfaces:**
- Consumes: `SwimlaneService.archive/restore` (Task 3), errors from catalog (Task 2), `resolveSwimlane` (`server/mcp/resolve.ts:44-59` — adds `availableSwimlanes`), admin gate pattern (create-swimlane.ts:19-21).
- Produces: MCP tools (name-exact): `update_swimlane` input gains `dueAt` (string, "YYYY-MM-DD" — optional); `create_task` input `swimlane` becomes optional (description: "Swimlane name (case-insensitive). Omitted → task lands in the project's Backlog lane") + gains `dueAt` (optional string); `update_task` input gains `dueAt` (optional); `create_swimlane` passes `dueAt` (optional); NEW `archive_swimlane` `{ project*, swimlane* }` admin-only → "Swimlane archived" + archived task count; NEW `restore_swimlane` `{ project*, swimlane* }` admin-only → "Swimlane restored". Tool count 37 → 39.

- [ ] **Step 1: update_swimlane + create_swimlane dueAt.** `update-swimlane.ts`: add `dueAt: { type: "string", description: "Milestone due date (YYYY-MM-DD). Omit to leave unchanged; empty string clears it." }` to properties (optional, not required). Handler: `if (args.dueAt !== undefined) patch.dueAt = args.dueAt === "" ? null : args.dueAt;` then service.update. `create-swimlane.ts`: add `dueAt` optional, pass through (kind stays milestone server-side).
- [ ] **Step 2: create_task optional swimlane + dueAt.** `create-task.ts`: move `swimlane` out of `required` (keep in properties). Add `dueAt: { type: "string", description: "Task due date (YYYY-MM-DD), optional; must not be later than the swimlane's due date" }`. Handler: resolve swimlane only when `args.swimlane` provided; else pass `swimlaneId: undefined` (service defaults to Backlog). Include `dueAt` in TaskSummary output shape.
- [ ] **Step 3: update_task dueAt.** Add `dueAt` optional string to input schema; pass through (`""` → null to clear). TaskSummary gains `dueAt`.
- [ ] **Step 4: archive/restore swimlane tools.** New files mirroring `delete-swimlane.ts` structure (admin gate, `resolveSwimlane`, `buildToolError`):
```ts
// archive-swimlane.ts — inputSchema { project: string, swimlane: string }, required both
// handler: admin gate → swimlaneService.archive(actor, lane.id)
//   success message: `Archived swimlane "${lane.name}" (${activity.length} tasks archived)`
//   BacklogProtected → buildToolError (code BACKLOG_PROTECTED, message from catalog)
// restore-swimlane.ts — same but service.restore; message `Restored swimlane "${lane.name}"`
```
Register both in `server.ts` tools array (alphabetical-ish placement near the other swimlane tools). `Actor` for MCP: match how create-swimlane/delete-swimlane handlers build the actor (auth object → actor label; check existing pattern e.g. `actorFromAuth(auth)` if present).
- [ ] **Step 5: Tool count test.** `server/mcp/server.test.ts:76-79`: `toHaveLength(39)` and update the test name.
- [ ] **Step 6: Gate.** `npx tsc --noEmit` — clean. `bun run vitest run server/mcp/server.test.ts` — passes.

**Gate:** tsc clean; MCP tools test passes with 39 tools.

---

### Task 7: Docs — SCHEMA, LAYERS, API, MCP (orchestrator)

**Files:**
- Modify: `docs/SCHEMA.md`, `docs/LAYERS.md`, `docs/API.md`, `docs/MCP.md`

- [ ] **Step 1: SCHEMA.md.** Add the three `swimlanes` columns + `tasks.due_at` to the CREATE TABLE blocks (copy verbatim from migration 0005), document `idx_swimlanes_one_backlog`, the Backlog invariants (permanent, one per project, no deadline, create defaults to it, tasks.swimlane_id stays NOT NULL), and the service-enforced card-deadline rule (`tasks.due_at <= lane due_at`; `DEADLINE_AFTER_LANE`; no cross-column CHECK — note why).
- [ ] **Step 2: LAYERS.md.** Error catalog: add `DEADLINE_AFTER_LANE` (409) and `BACKLOG_PROTECTED` (409) with payloads; note archive cascade transaction semantics (lane + tasks in one tx, per-task `archived` rows); note `clearDueAt` atomicity in move.
- [ ] **Step 3: API.md.** Swimlane interface gains `dueAt/archivedAt/kind`; Task interface gains `dueAt`. Endpoint shapes: `POST /swimlanes` + `PATCH /swimlanes/:id` bodies gain `dueAt?`; new `POST /swimlanes/:id/archive` and `POST /swimlanes/:id/restore` (→ 200 `{ data: Swimlane, activity }` | 403 FORBIDDEN | 404 | 409 BACKLOG_PROTECTED); `POST /tasks` `swimlaneId?` (optional, defaults to Backlog) + `dueAt?`; `PATCH /tasks/:id` gains `dueAt?`; `PATCH /tasks/:id/move` body gains `clearDueAt?`, add `409 DEADLINE_AFTER_LANE` to its error list; `GET /board` note: `includeArchived=true` also returns archived lanes.
- [ ] **Step 4: MCP.md.** `create_task` — `swimlane` optional (default Backlog) + `dueAt?`; `update_task` — `dueAt?`; `update_swimlane`/`create_swimlane` — `dueAt?`; add `archive_swimlane` + `restore_swimlane` tool specs (admin-only, by name); document `BACKLOG_PROTECTED` + `DEADLINE_AFTER_LANE` errors; update tool count if mentioned.
- [ ] **Step 5: Gate.** Docs only — no gate beyond consistent grep: `rg "dueAt|archive_swimlane|DEADLINE_AFTER_LANE|BACKLOG_PROTECTED" docs/API.md docs/MCP.md docs/SCHEMA.md docs/LAYERS.md` — all four files match.

**Gate:** all four docs mention the new shapes; no doc mentions a shape the code doesn't implement.

---

### Task 8: Frontend data layer — types, api client, query hooks, move guard (fixer)

**Files:**
- Modify: `app/lib/api.ts` (task/swimlane client types + methods), `app/lib/queries.ts` (useUpdateTask ~173-195, useMoveTask ~220-242, swimlane hooks ~528-567, add useArchiveSwimlane/useRestoreSwimlane), `app/components/kanban/KanbanBoard.tsx` (move orchestration — deferred wiring to Task 9; hook only here)
- Create: `app/lib/dates.ts` (due-label helpers), `app/lib/useMoveGuard.ts` (shared confirm logic — component in Task 9)

**Interfaces:**
- Consumes: `Board`/`Swimlane`/`Task` types (Task 2 — now with dueAt/archivedAt/kind), REST shapes (Task 5).
- Produces: `api.updateTask(slug, id, input & { dueAt?: string | null })`; `api.moveTask(slug, id, target & { clearDueAt?: boolean })`; `api.createSwimlane/updateSwimlane` with `dueAt?: string | null`; `api.archiveSwimlane(slug, id)` / `api.restoreSwimlane(slug, id)` → `{ data: Swimlane; activity: ActivityEvent[] }`; hooks `useUpdateSwimlane` (+dueAt), `useArchiveSwimlane(slug)` / `useRestoreSwimlane(slug)` (setQueryData board both archived flags + `["projects", slug, "swimlanes"]`; toast), `useMoveTask` target type + `clearDueAt`; `formatDueLabel(dueAt: string, today?: Date)` → `{ text: "Due Fri" | "Due Fri · 3d left" | "Overdue 2d" | "Due today"; overdue: boolean }` (pure, exported — dates-only, parse `YYYY-MM-DD` as LOCAL date via `new Date(y, m-1, d)` to avoid TZ shift); `useMoveGuard(slug, board)` → `{ confirmMove(task, target): Promise<boolean>` — returns true when move proceeds (no guard needed or user confirmed), false when cancelled; conflict resolution applies `clearDueAt` to the mutation input.

- [ ] **Step 1: dates helper.** `app/lib/dates.ts`:
```ts
export function parseDateOnly(s: string): Date { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function formatDueLabel(dueAt: string, today = new Date()): { text: string; overdue: boolean } {
  const due = parseDateOnly(dueAt); const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { text: `Overdue ${-days}d`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: false };
  const weekday = due.toLocaleDateString("en-US", { weekday: "short" });
  return { text: days === 1 ? `Due ${weekday}` : `Due ${weekday} · ${days}d left`, overdue: false };
}
```
- [ ] **Step 2: api client.** Extend types + methods per Interfaces (mirror existing shapes; `archiveSwimlane`/`restoreSwimlane` follow `api.archiveTask`'s call pattern with the new paths `/swimlanes/:id/archive`).
- [ ] **Step 3: queries.** `useUpdateTask` mutationFn type gains `dueAt?: string | null`; `useMoveTask` mutationFn target gains `clearDueAt?: boolean` (pass through to api). `useUpdateSwimlane` input gains `dueAt?: string | null` — and its onSuccess must ALSO update board caches (`["board", slug, false]`/`["board", slug, true]` — map replace the lane in `board.swimlanes`), because the lane header now renders the due chip (previously swimlane updates only refreshed the settings list — stale board chip otherwise). `useCreateSwimlane` similar board update. New:
```ts
export function useArchiveSwimlane(slug: string) {
  const qc = useQueryClient(); const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.archiveSwimlane(slug, id),
    onSuccess: ({ data: lane, activity }) => {
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, swimlanes: old.swimlanes.map((l: Swimlane) => (l.id === lane.id ? lane : l)),
                   tasks: old.tasks.map((t: Task) => (activity.some((a) => a.taskId === t.id && a.type === "archived") ? { ...t, archivedAt: lane.archivedAt } : t)) };
        });
      }
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => old?.map((l) => (l.id === lane.id ? lane : l)));
      toast.push("success", activity.length > 0 ? `Swimlane archived (${activity.length} tasks)` : "Swimlane archived");
    },
  });
}
// useRestoreSwimlane mirrors — lane back to archivedAt null, tasks untouched.
```
(Check `ActivityEvent` field name for task id — match existing `prependActivity` usage; if the event doesn't carry taskId, derive archived task ids from the mutation response instead — the REST response's activity array is the authoritative source; see Task 5 response shape.)
- [ ] **Step 4: useMoveGuard.** `app/lib/useMoveGuard.ts`:
```ts
export function useMoveGuard(slug: string, board: Board | undefined) {
  const moveTask = useMoveTask(slug);
  const [pending, setPending] = useState<{ task: Task; target: MoveTarget } | null>(null);
  const confirmMove = (task: Task, target: MoveTarget) => {
    const lane = board?.swimlanes.find((l) => l.id === target.swimlaneId);
    const laneOverdue = !!lane?.dueAt && formatDueLabel(lane.dueAt).overdue;
    const conflict = !!task.dueAt && !!lane?.dueAt && task.dueAt > lane.dueAt;
    if (!laneOverdue && !conflict) { void moveTask.mutateAsync({ id: task.id, ...target }); return true; }
    setPending({ task, target }); return false;   // dialog renders (Task 9), confirm resolves
  };
  const resolve = (clearDueAt: boolean) => {
    if (!pending) return;
    void moveTask.mutateAsync({ id: pending.task.id, ...pending.target, ...(clearDueAt ? { clearDueAt: true } : {}) });
    setPending(null);
  };
  return { confirmMove, pending, resolve, cancel: () => setPending(null) };
}
```
- [ ] **Step 5: Gate.** `npx tsc --noEmit` — clean (component wiring in Task 9 may leave `pending` unused warnings — use it in Task 9; keep no-unused clean by exporting the hook from a file that Task 9 imports).

**Gate:** tsc clean.

---

### Task 9: Frontend UI — lane chips, card chip, dialogs, archived section, forms (fixer — transcribing Task 1 wireframes)

**Files:**
- Modify: `app/components/kanban/SwimlaneHeader.tsx` (due chip + archive/restore menu items), `app/components/kanban/TaskCard.tsx` (card-due chip), `app/components/kanban/BoardLane.tsx` (archived lanes split + section), `app/components/kanban/KanbanBoard.tsx` (move guard wiring + archived lanes section), `app/components/kanban/SwimlaneForm.tsx` (due date input), `app/components/kanban/KanbanSettingsModal.tsx` (dueAt passthrough), `app/components/TaskPropertyBar.tsx` (due date field ~after Type), `app/components/TaskDetail.tsx` (pass dueAt into create payload), `app/components/useTaskDetailActions.ts` (create payload + dueAt), `app/styles/phosphor.css` (port wireframe classes)
- Create: `app/components/kanban/MoveConfirmDialog.tsx`, `app/components/kanban/ArchivedLanesSection.tsx` (or inline in BoardLane — wireframe decides)

**Interfaces:**
- Consumes: `formatDueLabel` + `useMoveGuard` (Task 8), `useArchiveSwimlane`/`useRestoreSwimlane` (Task 8), `useUpdateSwimlane` (+dueAt, Task 8), wireframe classes (Task 1).
- Produces: rendered lane due chips + overdue red state; card deadline chips; move-confirm dialog with clear-deadline checkbox; archived lanes section with Restore; swimlane form due-date field (hidden for backlog kind + while archived); task property bar due-date field; create-task dueAt; all new classes ported into `app/styles/phosphor.css`.

- [ ] **Step 1: Port CSS.** Copy the new classes from `wireframes/src/wireframes.css` (Task 1) into `app/styles/phosphor.css` verbatim (`.lane-due`, `.lane-due-overdue`, `.card-due`, `.card-due-overdue`, `.swimlane-backlog`, `.swimlane-archived`, `.check-row`). PHOSPHOR tokens only.
- [ ] **Step 2: SwimlaneHeader.** Compute `due = lane.dueAt ? formatDueLabel(lane.dueAt) : null`; render `<span className={cn("lane-due", due?.overdue && "lane-due-overdue")}>{due.text}</span>` after the count (hide when `lane.kind === "backlog"` or archived). Menu: for `lane.kind === "milestone"`: add "Archive swimlane" item → `useArchiveSwimlane(slug).mutate({ id: lane.id })` (guard: only when `!lane.archivedAt`); for archived lanes: "Restore swimlane" item → restore mutation. No archive item on backlog (server rejects anyway — don't render it).
- [ ] **Step 3: TaskCard.** New optional prop `dueAt?: string | null`. When set, render `<span className={cn("card-due", overdue && "card-due-overdue")}>{formatDueLabel(dueAt).text}</span>` in `card-meta` before the assignees (wireframe order). Thread from BoardLane (task.dueAt) and from TaskDetail if it renders cards (check TaskDetail's card render usage — if unused there, board-only).
- [ ] **Step 4: MoveConfirmDialog.** New component: renders the wireframe's `.dialog` when `pending` is set — state (a) lane overdue → title "Overdue lane", body "Lane {name} is overdue ({n}d). Move anyway?", buttons [Cancel][Move]; state (b) conflict → body "Card due {taskDue} is later than lane due {laneDue}." + `.check-row` checkbox "Clear card deadline ({taskDue} → none)" + [Cancel][Move]. Confirm → `resolve(checkboxChecked)`; Cancel → `cancel()`. Mount it in KanbanBoard next to the other dialogs.
- [ ] **Step 5: KanbanBoard wiring.** Replace direct `onMoveTask(...)` in `handleDragEnd` with `confirmMove(task, target)` from `useMoveGuard(slug, board)` (rollback/optimistic logic stays — the guard replaces the commit call). The existing optimistic `setLocalTasks` runs before the guard; keep it only when the guard short-circuits (no dialog) — simplest: run guard FIRST, then optimistic + mutate on true; on false, dialog handles it (no optimistic move). Wire `pending` state into `<MoveConfirmDialog pending={pending} ... />`.
- [ ] **Step 6: Archived lanes section.** In `BoardLane`/`KanbanBoard`: split `board.swimlanes` into `live = swimlanes.filter(l => !l.archivedAt)` (plus backlog-first ordering — Backlog is position 0 from migration; keep board order) and `archived = swimlanes.filter(l => l.archivedAt)`. Render archived lanes only when `showArchived` (the existing toggle state in board.tsx) in a muted `.swimlane-archived` container at the bottom, each with Restore (Step 2's menu). Board counts/WIP only consider live lanes (archived tasks are already excluded from WIP queries).
- [ ] **Step 7: SwimlaneForm.** Add `Due date` field: `<input type="date" className="prop-input w-full" value={dueAt ?? ""} onChange={...} />` + helper text. In edit mode: hide the field entirely when `swimlane.kind === "backlog"` (annotation: Backlog has no deadline); when editing an archived lane, keep form read-only-ish (match existing behavior for archived — check current form; if none, just allow edit). Submit payload gains `dueAt: value === "" ? null : value`. KanbanSettingsModal passes `dueAt` into create/update mutations.
- [ ] **Step 8: TaskPropertyBar + create.** Add `Due date` `.prop-field` (after Type): `<input type="date" value={task.dueAt ?? ""} onChange={(e) => onUpdate?.(task.id, { dueAt: e.target.value === "" ? null : e.target.value })} />`. Create path: `useTaskDetailActions` create payload gains `dueAt` (from a date input in TaskDetail's create form — add to the create form's field set, `TaskDetail.tsx`), passed through `onCreate`.
- [ ] **Step 9: Gate.** `npx tsc --noEmit` — clean.

**Gate:** tsc clean.

---

### Task 10: Smoke verification (orchestrator)

- [ ] **Step 1: Static gates.** `npx tsc --noEmit` · `bun run vitest run` (shared + server suites) · `bash wireframes/build.sh` (cwd `wireframes/`) — all green.
- [ ] **Step 2: Dev stack.** Restart stack: kill listeners on 3000/5173, `nohup bash scripts/dev.sh > /tmp/opencode/dev-full.log 2>&1 &`; wait for health `{"ok":true}`.
- [ ] **Step 3: REST round-trip (plain curl — pipes with `rtk curl` corrupt JSON):**
```bash
curl -s http://localhost:3000/api/projects/emberfall/board | python3 -c "import json,sys; b=json.load(sys.stdin); print([(l['name'], l['kind'], l['dueAt'], l['archivedAt']) for l in b['swimlanes']])"
# 1) lane with dueAt: PATCH an existing lane → dueAt '2026-08-14' (check BACKLOG_PROTECTED on backlog lane deadline)
# 2) create task with dueAt + no swimlane → lands in Backlog; dueAt later than lane → 409 DEADLINE_AFTER_LANE
# 3) move card with dueAt into lane due sooner, no clearDueAt → 409; with clearDueAt:true → 200, task.dueAt null
# 4) archive lane → 200 + all its tasks archivedAt set (activity rows: one per task); lane archivedAt set
# 5) restore lane → lane archivedAt null, tasks still archived
# 6) GET board?includeArchived=true → archived lane present; without → absent
```
- [ ] **Step 4: MCP round-trip (lexa-cli or direct MCP call with lxk_ key):** `create_task` without swimlane → Backlog; `create_task` with `dueAt` after lane due → DEADLINE_AFTER_LANE with `details`; `update_swimlane` with `dueAt`; `archive_swimlane` on Backlog → BACKLOG_PROTECTED; `archive_swimlane` on a milestone lane → ok; `restore_swimlane` → ok. Verify `tools/list` → 39.
- [ ] **Step 5: UI smokes (agent-browser snapshots, no vision):** board shows Backlog lane first (muted, no due chip, no archive in menu); milestone lane header shows due chip + countdown; overdue lane → red chip; card with own deadline → chip on card; card in Backlog with own deadline → chip present; drag card into overdue lane → confirm dialog appears; conflict drag → dialog with checkbox; check → move commits + card deadline cleared; uncheck → cancelled; archive lane from menu → lane disappears from live board + toast; restore from archived view → back; SwimlaneForm shows date input for milestone, none for Backlog; TaskDetail property bar shows due date field; create task form has due date.
- [ ] **Step 6: Report.** Summarize gates + smokes; list declared deviations (SQLite CHECK → service-enforced; move_task MCP shape unchanged; backfilled Backlog position; any test-fixture updates). Await user before committing.

**Gate:** all smokes pass; deviations reported.

---

## Self-Review

**Spec coverage:** spec's schema (due_at ×2, archived_at, kind, one-backlog index) → Task 2; Backlog default on create → Tasks 2 (seed) + 4 (service) + 6 (MCP); lane/task dueAt in REST → Task 5; move clearDueAt + DEADLINE_AFTER_LANE → Tasks 4 + 5; lane archive cascade + restore → Tasks 3 + 5 + 6; BACKLOG_PROTECTED → Tasks 2-3; board includeArchived lanes → Tasks 3 + 5; wireframes (lane chip, card chip, dialogs, archived section, settings date input) → Task 1; UI transcription → Task 9; activity `dueAt` message + cascade `archived` rows → Tasks 2 + 3; docs → Task 7. Non-goals untouched (no roadmap view, no GitHub deadline sync, date-only, no hard enforcement — no task violates them).

**Placeholder scan:** no TBD/TODO; every code step has exact code or a precise existing anchor. One intentional seam: Task 3's cascade calls `taskRepo.findBySwimlane` defined in Task 4 step 1 — ordering is explicit (implement Task 4 step 1 before Task 3 step 4, or together; both are the same server lane).

**Type consistency:** `dueAt: string | null` everywhere (REST `NullOr(String)`; MCP `""` → null convention documented); `clearDueAt?: boolean` on `MoveTarget` (service), `MoveTaskPayload` (REST), move mutation input + api client (Task 8); `kind: "backlog" | "milestone"` literal union in shared types + REST `Literal`; `formatDueLabel` returns `{ text, overdue }` — used by both SwimlaneHeader and TaskCard identically; activity variant `"dueAt"` matches the dispatcher's extended union in Task 2 and the emission in Task 4.

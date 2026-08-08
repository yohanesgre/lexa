# Project Tasks List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project flat task list at `/$slug/tasks` (new "Tasks" top-nav tab) with search, column/type/priority filters, archived toggle, sorting, and click-through to the existing TaskDetail slideover.

**Architecture:** Zero backend changes (Approach A). New `useTasks()` hook wraps the existing board query under the same query key `["board", slug, showArchived]` so board and list share one cache entry; it derives a flat, display-ready list (column/swimlane names, priority/type label+color resolved from `fieldConfig`). The page filters/sorts in-memory with `useMemo`; detail opens via `?task=<id>` exactly like the board route.

**Tech Stack:** TanStack Start route `app/routes/$slug/tasks.tsx` · react-query (`app/lib/queries.ts`) · existing `TaskDetail` component · Tailwind/PHOSPHOR classes in `app/styles/phosphor.css` · wireframes in `wireframes/src/`.

## Global Constraints

- **Wireframe-first (non-negotiable):** Task 1 (wireframes) MUST complete and pass its gate BEFORE any React implementation task starts. Never run wireframe work and frontend implementation in parallel.
- **Zero backend:** never touch `server/`, `shared/types.ts`, `docs/API.md`, `docs/SCHEMA.md`, `package.json`, `app.config.ts`.
- **Names are exact:** route `/$slug/tasks`, tab label "Tasks", hook `useTasks`, query key `["board", slug, showArchived]` (must match `useBoard` exactly — shared cache is the point).
- **Task.priority / Task.type are FieldOption ids**, not labels — resolve via `board.fieldConfig.priorities` / `.types` (see Task 2). Never hardcode hex colors in TS; empty color string → default chip class.
- **PHOSPHOR tokens only** in `phosphor.css` (CSS variables, no raw hex outside it).
- **Mutation path uses `setQueryData`** (invariant 6) — never `invalidateQueries` on the mutation path; the list updates via the shared board key automatically.
- **No git commits unless the user explicitly asks.** Stage at task boundaries; commit+push as one batch when the user requests it.
- **TypeScript strict, no `any`** outside JSON-payload boundaries.
- **No scope creep:** browse + open detail only. No inline edits in the list, no bulk ops, no export, no pagination, no cross-project list.

---

### Task 1: Wireframes — tasks page (designer lane)

**Files:**
- Create: `wireframes/src/tasks.html`
- Modify: `wireframes/src/partials/navbar.html` (Tasks tab), `wireframes/src/index.html` (browse entry), `wireframes/src/flow-overview.html` (Tasks node)
- Run: `bash wireframes/build.sh` (never edit `wireframes/dist/` by hand)

**Interfaces:**
- Consumes: existing wireframe conventions (annotations via `<span class="annotation-tag">`, `<INCLUDE partials/navbar.html />`, `wireframes.css` tokens/classes).
- Produces: `wireframes/src/tasks.html` — the binding spec for Tasks 3/5. All visual classes used in this file (e.g. `tasks-filter`, `task-row`, `task-chip`, skeleton/empty/no-match states) are the class names Tasks 3 and 5 must use/port.

- [ ] **Step 1: Create `wireframes/src/tasks.html`**

  New page matching house conventions (see `wireframes/src/dashboard.html` for the header/structure pattern). Content requirements, all states rendered in-file with visible annotations:

  1. `<INCLUDE partials/navbar.html />` at top; body uses the same page wrapper classes as dashboard.html.
  2. **Header:** "Tasks" title + project name + unfiltered total count (e.g. "42 tasks") — annotation: count = total for the project, not filtered count.
  3. **Filter bar:** search input (placeholder "Search tasks…"), column dropdown, type dropdown, priority dropdown, sort dropdown (Board order · Priority · Newest created), archived toggle. Annotations: dropdowns list only values present in the project (columns/fieldConfig); filters intersect; sort is single-active; archived toggle mirrors board semantics (archived excluded from count, toggle shows dimmed rows).
  4. **Rows:** title (primary, truncates) + column badge + swimlane name + type chip + priority chip (colored) + GitHub indicator (when linked, e.g. `#142`) + created date. Row hover highlight; annotation: click opens TaskDetail slideover via `?task=<id>`, back clears param and filters persist (filters live in component state, not URL).
  5. **States, each as its own annotated block:** loading skeleton rows · empty project (no tasks — CTA "Open board") · no match (filters active — "No tasks match" + "Clear filters" button) · error panel + retry.
  6. All notes/decisions as `<span class="annotation-tag">` — never plain HTML comments.

- [ ] **Step 2: Add the Tasks tab to the navbar partial**

  In `wireframes/src/partials/navbar.html`, between Board and Wiki:

  ```html
  <a href="tasks.html" class="nav-link">Tasks</a>
  ```

  (board links to `kanban.html`, wiki to `wiki.html` — mirror those href conventions.)

- [ ] **Step 3: Update browse index + flow overview**

  - `wireframes/src/index.html`: add a Tasks entry to the page list, mirroring how other pages are listed (check how kanban/dashboard entries are structured and copy that row style).
  - `wireframes/src/flow-overview.html`: add the Tasks node — browse/search/sort tasks of selected project → open task detail. Mirror the existing board-node annotation style.

- [ ] **Step 4: Build and verify**

  Run: `bash wireframes/build.sh`
  Expected: exit 0, no errors; `wireframes/dist/tasks.html` exists (build output — never edited by hand).

  Gate: build renders · annotations present (visible text, not HTML comments) · no `wireframes/dist/` hand-edits.

---

### Task 2: `useTasks()` hook (fixer lane)

**Files:**
- Modify: `app/lib/queries.ts` (append near `useBoard`, after line 87)

**Interfaces:**
- Consumes: `api.getBoard(slug, includeArchived)` (already used by `useBoard` at line 85-87), `Board`, `Column`, `Swimlane`, `FieldConfig` types from `shared/types.ts`.
- Produces:
  - `export interface TaskListItem { id: string; title: string; priorityId: string; priorityLabel: string; priorityColor: string; typeId: string; typeLabel: string; typeColor: string; columnId: string; columnName: string; swimlaneName: string; githubNumber: number | null; archivedAt: string | null; createdAt: string; updatedAt: string; }`
  - `export function deriveTaskList(board: Board): TaskListItem[]` (pure — exported for reuse/tests)
  - `export function useTasks(slug: string, showArchived = false): { data: Board | undefined; board: Board | undefined; tasks: TaskListItem[] | undefined; isLoading: boolean; isError: boolean; error: unknown; }` — spread of the underlying `useQuery` result plus `board` and `tasks`.

- [ ] **Step 1: Add the derived list helper**

  Append to `app/lib/queries.ts`:

  ```ts
  export interface TaskListItem {
    id: string;
    title: string;
    priorityId: string;
    priorityLabel: string;
    priorityColor: string;
    typeId: string;
    typeLabel: string;
    typeColor: string;
    columnId: string;
    columnName: string;
    swimlaneName: string;
    githubCount: number;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }

  export function deriveTaskList(board: Board): TaskListItem[] {
    const columnName = new Map(board.columns.map((c) => [c.id, c.name]));
    const swimlaneName = new Map(board.swimlanes.map((s) => [s.id, s.name]));
    const priority = new Map(board.fieldConfig.priorities.map((o) => [o.id, o]));
    const type = new Map(board.fieldConfig.types.map((o) => [o.id, o]));
    return board.tasks.map((t) => {
      const p = priority.get(t.priority);
      const ty = type.get(t.type);
      return {
        id: t.id,
        title: t.title,
        priorityId: t.priority,
        priorityLabel: p?.label ?? t.priority,
        priorityColor: p?.color ?? "",
        typeId: t.type,
        typeLabel: ty?.label ?? t.type,
        typeColor: ty?.color ?? "",
        columnId: t.columnId,
        columnName: columnName.get(t.columnId) ?? "Unknown column",
        swimlaneName: swimlaneName.get(t.swimlaneId) ?? "Unknown swimlane",
        githubNumber: t.githubs[0]?.issueNumber ?? null,
        archivedAt: t.archivedAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
  }
  ```

  (`Board`/`TaskListItem` import: `Board` is already imported in queries.ts — verify at top of file; if not, add `Board` to the existing `shared/types` import.)

- [ ] **Step 2: Add the hook**

  Append after `deriveTaskList`:

  ```ts
  export function useTasks(slug: string, showArchived = false) {
    const query = useQuery({
      queryKey: ["board", slug, showArchived],
      queryFn: () => api.getBoard(slug, showArchived),
    });
    const board = query.data;
    const tasks = useMemo(() => (board ? deriveTaskList(board) : undefined), [board]);
    return { ...query, board, tasks };
  }
  ```

  Add `useMemo` to the existing `react` import in queries.ts (check current imports; if `useMemo` is not imported, extend `import { useMemo } from "react"`).

- [ ] **Step 3: Verify**

  Run: `npx tsc --noEmit`
  Expected: clean, no errors. (`git diff --stat` vs `server/`, `shared/types.ts`, `docs/*` must be empty.)

---

### Task 3: Route page `/$slug/tasks` (fixer lane)

**Files:**
- Create: `app/routes/$slug/tasks.tsx`

**Interfaces:**
- Consumes: `useTasks(slug, showArchived)` from Task 2 · `useBoard(slug, showArchived)` (for dropdown options + TaskDetail props — same query key, no extra fetch) · existing mutations from `app/lib/queries.ts`: `useMoveTask(slug)`, `useUpdateTask(slug)`, `useDeleteTask(slug)`, `useArchiveTask(slug)`, `useRestoreTask(slug)`, `useLinkGithubIssue(slug)`, `useUnlinkGithubIssue(slug)` · `TaskDetail` component + `MoveTarget` type from `app/components/kanban/KanbanBoard` · wireframe class names from `wireframes/src/tasks.html` (Task 1) — the markup below uses those classes; adjust class names if the wireframe differs (wireframe wins).
- Produces: route `/$slug/tasks` with `validateSearch { task?: string }` — Tasks 4 relies on it existing; the file is the canonical place to look up how the page behaves.

- [ ] **Step 1: Write the route file**

  Create `app/routes/$slug/tasks.tsx` with this full content (structure mirrors `app/routes/$slug/index.tsx` — detail handling, mutations, and navigation are identical patterns):

  ```tsx
  import { createFileRoute } from "@tanstack/react-router";
  import { useMemo, useState } from "react";
  import { useBoard, useTasks, useMoveTask, useUpdateTask, useDeleteTask, useArchiveTask, useRestoreTask, useLinkGithubIssue, useUnlinkGithubIssue } from "../../lib/queries";
  import { useToast } from "../../components/ui/Toast";
  import { TaskDetail } from "../../components/TaskDetail";
  import type { MoveTarget } from "../../components/kanban/KanbanBoard";
  import type { Task, TipTapDoc } from "../../../shared/types";

  export const Route = createFileRoute("/$slug/tasks")({
    validateSearch: (search: Record<string, unknown>): { task?: string } => ({
      task: typeof search.task === "string" ? search.task : undefined,
    }),
    component: TasksPage,
  });

  type SortKey = "board" | "priority" | "created";

  function TasksPage() {
    const { slug } = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const toast = useToast();

    const [showArchived, setShowArchived] = useState(false);
    const [query, setQuery] = useState("");
    const [columnId, setColumnId] = useState("");
    const [typeId, setTypeId] = useState("");
    const [priorityId, setPriorityId] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("board");

    const { board, tasks, isLoading, error, refetch } = useTasks(slug, showArchived);
    const boardQuery = useBoard(slug, showArchived);
    const columns = boardQuery.data?.columns ?? [];
    const swimlanes = boardQuery.data?.swimlanes ?? [];
    const fieldConfig = boardQuery.data?.fieldConfig;

    const moveTask = useMoveTask(slug);
    const updateTask = useUpdateTask(slug);
    const deleteTask = useDeleteTask(slug);
    const archiveTask = useArchiveTask(slug);
    const restoreTask = useRestoreTask(slug);
    const linkGithubIssue = useLinkGithubIssue(slug);
    const unlinkGithubIssue = useUnlinkGithubIssue(slug);

    const hasActiveFilters = query !== "" || columnId !== "" || typeId !== "" || priorityId !== "";

    const filtered = useMemo(() => {
      let list = tasks ?? [];
      const q = query.trim().toLowerCase();
      if (q) list = list.filter((t) => t.title.toLowerCase().includes(q));
      if (columnId) list = list.filter((t) => t.columnId === columnId);
      if (typeId) list = list.filter((t) => t.typeId === typeId);
      if (priorityId) list = list.filter((t) => t.priorityId === priorityId);
      const priorityPos = new Map((fieldConfig?.priorities ?? []).map((o) => [o.id, o.position]));
      if (sortKey === "priority") {
        list = [...list].sort((a, b) => (priorityPos.get(a.priorityId) ?? 999) - (priorityPos.get(b.priorityId) ?? 999));
      } else if (sortKey === "created") {
        list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      return list;
    }, [tasks, fieldConfig, query, columnId, typeId, priorityId, sortKey]);

    const clearFilters = () => {
      setQuery("");
      setColumnId("");
      setTypeId("");
      setPriorityId("");
    };

    const selectedTaskId = search.task ?? null;
    const selectedTask = selectedTaskId ? boardQuery.data?.tasks.find((t) => t.id === selectedTaskId) ?? null : null;

    const handleMove = async (taskId: string, target: MoveTarget) => {
      await moveTask.mutateAsync({ id: taskId, ...target });
    };
    const handleUpdate = (id: string, data: Partial<Task>) => {
      updateTask.mutate({ id, ...data });
    };
    const handleDelete = async (id: string) => {
      try {
        await deleteTask.mutateAsync({ id });
        navigate({ search: { task: undefined }, replace: true } as never);
      } catch {
        // error toast comes from the mutation
      }
    };
    const handleArchive = async (id: string) => {
      try {
        await archiveTask.mutateAsync({ id });
        navigate({ search: { task: undefined }, replace: true } as never);
      } catch {
        // error toast comes from the mutation
      }
    };
    const handleRestore = async (id: string) => {
      try {
        await restoreTask.mutateAsync({ id });
      } catch {
        // error toast comes from the mutation
      }
    };
    const handleLinkGithub = async (id: string, repo: string) => {
      const { data: task } = await linkGithubIssue.mutateAsync({ id, repo });
      const linked = task.githubs.find((g) => g.repo === repo);
      return linked ? { repo: linked.repo, issueNumber: linked.issueNumber } : null;
    };
    const handleUnlinkGithub = async (id: string, issueId: string) => {
      await unlinkGithubIssue.mutateAsync({ id, issueId });
    };
    const handleSelectTask = (task: TaskListItem) => {
      navigate({ search: { task: task.id }, replace: true } as never);
    };
    const handleClose = () => {
      navigate({ search: { task: undefined }, replace: true } as never);
    };
    const handleCreate = async (_input: { title: string; columnId: string; priority: string; type: string; assignees: string[]; description: TipTapDoc }) => {
      // browse-only page: creation happens on the board; this keeps TaskDetail's prop contract complete
      toast.push("info", "Create tasks from the board", "Open Board → column menu → Add task");
    };

    if (isLoading) {
      return (
        <div className="tasks-page">
          <div className="tasks-header">
            <div className="skeleton" style={{ width: 140, height: 22 }} />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="task-row">
              <div className="skeleton" style={{ width: i === 0 ? "55%" : `${40 + i * 9}%`, height: 14 }} />
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="tasks-error">
          <div className="tasks-error-title">Failed to load tasks</div>
          <div className="tasks-error-sub">{(error as Error).message}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      );
    }
    if (!board || !tasks) return <div className="tasks-error">Project not found</div>;

    const emptyProject = board.tasks.length === 0;

    return (
      <div className="tasks-page">
        <div className="tasks-header">
          <div>
            <h1 className="tasks-title">Tasks</h1>
            <div className="tasks-sub">
              {board.project.name} · {board.tasks.length} total
            </div>
          </div>
        </div>

        <div className="tasks-filter">
          <input
            className="tasks-search"
            type="search"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="tasks-select" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
            <option value="">All columns</option>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select className="tasks-select" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">All types</option>
            {(fieldConfig?.types ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <select className="tasks-select" value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
            <option value="">All priorities</option>
            {(fieldConfig?.priorities ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <select className="tasks-select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="board">Board order</option>
            <option value="priority">Priority</option>
            <option value="created">Newest created</option>
          </select>
          <button
            type="button"
            className={showArchived ? "tasks-archive-toggle on" : "tasks-archive-toggle"}
            onClick={() => setShowArchived((v) => !v)}
          >
            Archived
          </button>
        </div>

        {emptyProject ? (
          <div className="tasks-empty">
            <div className="tasks-empty-title">No tasks yet</div>
            <div className="tasks-empty-sub">Create tasks from the board.</div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate({ to: "/$slug", params: { slug } } as never)}>
              Open board
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="tasks-empty">
            <div className="tasks-empty-title">No tasks match</div>
            <div className="tasks-empty-sub">Try adjusting your filters.</div>
            {hasActiveFilters && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="tasks-list">
            {filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.archivedAt ? "task-row archived" : "task-row"}
                onClick={() => handleSelectTask(t)}
              >
                <span className="task-row-title">{t.title}</span>
                <span className="task-row-meta">
                  <span className="task-chip column">{t.columnName}</span>
                  <span className="task-chip swimlane">{t.swimlaneName}</span>
                  <span className="task-chip type" style={t.typeColor ? { color: t.typeColor, borderColor: t.typeColor } : undefined}>
                    {t.typeLabel}
                  </span>
                  <span className="task-chip priority" style={t.priorityColor ? { color: t.priorityColor, borderColor: t.priorityColor } : undefined}>
                    {t.priorityLabel}
                  </span>
                  {t.githubNumber !== null && <span className="task-gh">#{t.githubNumber}</span>}
                  <span className="task-row-date">{t.createdAt.slice(0, 10)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedTaskId !== null && (
          <TaskDetail
            mode="view"
            task={selectedTask ?? undefined}
            columns={columns}
            swimlanes={swimlanes}
            columnRequiredFields={columns.map((column) => ({
              columnId: column.id,
              fields: column.requiredFields,
            }))}
            availableAssignees={[...new Set(board.tasks.flatMap((t) => t.assignees))] as string[]}
            taskTitles={new Map(board.tasks.map((t) => [t.id, t.title]))}
            fieldConfig={board.fieldConfig}
            onClose={handleClose}
            onUpdate={handleUpdate}
            onMove={handleMove}
            onDelete={handleDelete}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onLinkGithub={handleLinkGithub}
            onUnlinkGithub={handleUnlinkGithub}
            onCreate={handleCreate}
          />
        )}
      </div>
    );
  }
  ```

  Note: `TaskListItem` must be imported from `../../lib/queries`. If `TaskDetail`'s props require `mode` and no `create` path is reachable here, keep `mode="view"` — matches the spec (browse + open detail). The `handleCreate` stub keeps the prop contract complete without adding a create flow (scope: no inline edits/creation on this page).

- [ ] **Step 2: Verify route generation + typecheck**

  The TanStack vite plugin regenerates `app/routeTree.gen.ts` on dev/build. If the dev server (`bun run dev:full`) is running, it regenerates automatically; otherwise run `npx vite build` once or `bun run dev` briefly.

  Run: `npx tsc --noEmit`
  Expected: clean. If `routeTree.gen.ts` is stale, restart/run the dev server first, then re-run tsc.

- [ ] **Step 3: Sanity check against the wireframe**

  Open `wireframes/dist/tasks.html` and compare class names + structure with this route's JSX: title, filter bar order (search → column → type → priority → sort → archived), row child order (title → column → swimlane → type → priority → GitHub → date), empty/no-match states. The wireframe wins on any drift — rename classes in this file to match it exactly.

---

### Task 4: Nav plumbing (fixer lane)

**Files:**
- Modify: `app/components/layout/AppShell.tsx` (lines 13-28, 40-42)
- Modify: `app/components/layout/ProjectSwitcher.tsx` (line 9)

**Interfaces:**
- Consumes: `/$slug/tasks` route from Task 3; existing `NavLink` component (`to`, `params`, `active`, `exact` props).
- Produces: `routeType` union includes `"tasks"`; "Tasks" tab in the app nav; switcher treats tasks pages like board pages (`/$slug` target).

- [ ] **Step 1: AppShell — routeType + tab**

  In `app/components/layout/AppShell.tsx`:

  1. Widen the union (line 13):
  ```ts
  const routeType: "dashboard" | "board" | "tasks" | "wiki" | "settings" = useMemo(() => {
  ```
  2. Add the tasks match before the board match (line 18-19 region):
  ```ts
  if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
  ```
  3. Add targets next to boardTo/wikiTo (line 25-28):
  ```ts
  const tasksTo = selectedSlug ? "/$slug/tasks" : "/";
  const tasksParams = selectedSlug ? { slug: selectedSlug } : undefined;
  ```
  4. Add the tab between Board and Wiki (line 39-42):
  ```tsx
  <NavLink to={tasksTo} params={tasksParams} active={routeType === "tasks"} exact>
    Tasks
  </NavLink>
  ```

- [ ] **Step 2: ProjectSwitcher — widen routeType**

  In `app/components/layout/ProjectSwitcher.tsx` line 9, widen the prop type:

  ```ts
  export function ProjectSwitcher({ routeType }: { routeType: "dashboard" | "board" | "tasks" | "wiki" | "settings" }) {
  ```

  `targetFor` already falls through to `"/$slug"` for anything that isn't dashboard/wiki — tasks pages therefore target `/$slug`, exactly like board pages. No other change needed.

- [ ] **Step 3: Verify**

  Run: `npx tsc --noEmit`
  Expected: clean.

---

### Task 5: Port wireframe classes + UI alignment (designer lane)

**Files:**
- Modify: `app/styles/phosphor.css` (append task-list classes)

**Interfaces:**
- Consumes: `wireframes/src/tasks.html` (Task 1) — its exact class names and visual spec.
- Produces: `tasks-*` / `task-row*` classes in `phosphor.css` so the app renders identically to the wireframe.

- [ ] **Step 1: Port every class used by the tasks wireframe**

  For each class used in `wireframes/src/tasks.html` (`tasks-page`, `tasks-header`, `tasks-title`, `tasks-sub`, `tasks-filter`, `tasks-search`, `tasks-select`, `tasks-archive-toggle` (+ `.on`), `tasks-list`, `task-row` (+ `.archived`), `task-row-title`, `task-row-meta`, `task-chip` (+ `.column`/`.swimlane`/`.type`/`.priority` variants), `task-gh`, `task-row-date`, `tasks-empty` (+ title/sub), `tasks-error`, skeleton states):

  - Port wireframe CSS into `app/styles/phosphor.css` as **flat selectors** (house convention — see how the `status-*` classes were ported for the dashboard: `status-column-count`, `status-bar`, `status-bar-ok/approaching/exceeded/empty`).
  - Use PHOSPHOR CSS variables (`var(--lx-*)`) only — no raw hex outside `phosphor.css` (and inside, hex only for token definitions).
  - Chip colors: keep chips neutral by default; colored type/priority chips get their color from inline `style` (Task 3 already sets color + borderColor from fieldConfig) — the class must not hardcode those colors.
  - Row hover + `.archived` dimming: match the wireframe exactly.
  - Skeleton styles: reuse the existing `.skeleton` / `.skeleton-circle` classes already in phosphor.css.

- [ ] **Step 2: Structural check against the wireframe**

  With `bun run dev:full` running, open `http://localhost:5173/emberfall/tasks` (or the seed project's slug) via agent-browser and take an accessibility snapshot. Compare against `wireframes/dist/tasks.html` (serve via `python3 -m http.server` if needed):
  - header title/sub, filter bar order, row child order, empty/no-match/error copy — all identical to the wireframe.
  - GitHub indicator, date format (`YYYY-MM-DD` via `createdAt.slice(0, 10)`).
  - Fix any drift in this file (classes/structure), never by changing the wireframe (wireframe is truth).

  Gate: tsc clean · rendered page structurally matches `wireframes/src/tasks.html` (accessibility-tree diff) · no backend/shared/docs edits.

---

### Task 6: Smoke verification (orchestrator)

**Files:**
- Run-only: no code changes.

**Interfaces:**
- Consumes: the shipped page from Tasks 1-5 + dev stack (`bun run dev:full`).

- [ ] **Step 1: Gates**

  Run: `npx tsc --noEmit` and `bun run vitest run --reporter=json --outputFile=/tmp/opencode/vitest.json`
  Expected: tsc clean · vitest 75/75 suites, 219/219 tests (shared untouched — no expected changes).

- [ ] **Step 2: Smoke scenarios (agent-browser snapshots, no vision)**

  With `bun run dev:full` up:
  1. Tasks tab visible and active on `/$slug/tasks`; navbar Dashboard/Board/Tasks/Wiki order correct.
  2. List renders all tasks + unfiltered count ("<project> · N total"); rows ordered by board order.
  3. Search narrows; column/type/priority dropdowns filter (intersecting); archived toggle shows dimmed archived rows.
  4. Sort: priority reorders by fieldConfig position; newest created reorders by createdAt desc.
  5. Row click → TaskDetail slideover opens with `?task=<id>` in URL; close/back clears the param; filters retained.
  6. ProjectSwitcher on tasks page: picking another project → `/$slug` (board target); picking from dashboard stays on `/`.
  7. Empty project (fresh DB project with no tasks) → "No tasks yet" + Open board CTA.
  8. Filters with no matches → "No tasks match" + Clear filters button; clearing restores the list.
  9. Backend untouched: `git diff --stat` vs `server/`, `shared/types.ts`, `docs/*` = zero.
  10. Wireframe build still green: `bash wireframes/build.sh`.

- [ ] **Step 3: Report**

  Paste gate outputs + smoke results. Stage all changed files; commit+push only when the user asks.

---

## Self-Review

**Spec coverage:**
- Per-project list → Tasks 2/3 (useTasks + route) ✓
- Top-nav tab → Task 4 ✓
- Browse + open detail → Task 3 (TaskDetail wiring, `?task=`) ✓
- Flat list + filters/sort → Task 3 (useMemo pipeline, 4 filters + 3 sorts) ✓
- Archived toggle (board semantics, dimmed rows) → Task 3 (showArchived + `.archived` class) ✓
- Empty project vs no-match states → Task 3 ✓
- useTasks shared cache → Task 2 (same query key as useBoard) ✓
- Wireframe-first sequencing → Task 1 gate before Tasks 2-6 ✓
- Zero backend → Global Constraints + per-task gates ✓
- Verification (gates + smokes + backend-untouched diff) → Task 6 ✓

**Placeholder scan:** no TBD/TODO; every step has concrete code or an exact file/command. `handleCreate` is a deliberate no-op stub with a toast (documented behavior, not a placeholder).

**Type consistency:** `TaskListItem` fields used in Task 3 (`id`, `title`, `columnId`, `typeId`, `priorityId`, `priorityLabel`, `typeColor`, `githubCount`, `createdAt`, `archivedAt`) all defined in Task 2's interface. `useTasks` return shape (`board`, `tasks`, `isLoading`, `error`) matches Task 3's destructuring. Route name `/$slug/tasks` consistent across Tasks 1/3/4. Query key `["board", slug, showArchived]` identical in Tasks 2 and `useBoard`.

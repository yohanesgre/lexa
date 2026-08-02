# Lexa — Backlog

> Tracks implementation gaps between wireframes (source of truth) and current code. Each item references the relevant design doc.

## TASK LINKS

### ✅ TASKLINK-1: Subtask / blocked-by / related links + @-autocomplete

Wireframes `kanban.html` (subtask cards) + `task-detail.html` (Links section) show task-to-task linking. Implemented as one directed `task_links` table with three relations.

**Backend:**
- [x] `migrations/0012_task_links.sql` — `task_links` (project-scoped, unique from/to/relation)
- [x] `server/repos/task-link.repo.ts` + `server/services/task-link.service.ts` — CRUD, cycle guard (ancestor walk), child column inheritance, search
- [x] `server/services/task.service.ts` — create with `parentId` (auto-link + column inheritance), move cascades to children
- [x] `server/api/http.ts` — task-links group (list/add/remove) + `GET /tasks/search?q&exclude` + board carries `links`

**Frontend:**
- [x] `app/components/forge/LinksSection.tsx` — link list (relation label + title + remove), @-autocomplete dropdown (title + column) + relation picker
- [x] `app/components/kanban/TaskCard.tsx` — parent chevron + child count, blocked-by warning dot, subtask indent/dim
- [x] `app/components/kanban/KanbanBoard.tsx` — group children under parents, collapse toggle, move cascade via board.links
- [x] `app/lib/api.ts` + `queries.ts` — link CRUD + task search hooks

**Refs:** SCHEMA.md §Task links, API.md §Task Links, LAYERS.md §TaggedErrors, DESIGN_SYSTEM.md §5.9k, wireframes/kanban.html + task-detail.html

## FORGE

### ✅ FORGE-1: Runtime agent writing assistant (multica-style daemon)

Wireframe `forge-popover.html` + `_editor-toolbar.html` show the Forge AI writing button. Implemented as a daemon runtime: a `scripts/forge/daemon.ts` process registers as a runtime, polls for tasks, spawns the installed agent CLI (opencode/hermes) one-shot per task, and reports the result back.

**Backend:**
- [x] `migrations/0011_forge_runtimes.sql` — `runtimes`, `forge_tasks`, `document_sources`
- [x] `server/repos/forge.repo.ts` + `server/services/forge.service.ts` — runtime register/heartbeat, FIFO task claim, prompt build (action + doc context + resolved sources)
- [x] `server/repos/source.repo.ts` + `server/services/source.service.ts` — per-document sources, wiki resolution, external fetch with SSRF guard (`server/forge-ssrf.ts` + tests)
- [x] `server/api/http.ts` — forge group: register/claim/complete/fail/tasks + sources CRUD; daemon auth via `x-forge-token` (`LXK_FORGE_DAEMON_TOKEN`) in `server/entry.ts`
- [x] `scripts/forge/daemon.ts` + `scripts/forge/install.sh` (systemd user unit) + `forge:daemon` npm script

**Frontend:**
- [x] `app/components/forge/ForgePopover.tsx` — action chips, persisted sources, Generate → poll → Accept/Reject
- [x] `app/components/forge/SourcesSection.tsx` — wiki/URL add + remove, reused on TaskDetail + WikiPageViewer + popover
- [x] `TextEditor.tsx` / `TaskDetail.tsx` / `WikiPageViewer.tsx` — wired via `forge` prop
- [x] `app/lib/api.ts` + `queries.ts` — forge + sources hooks

**Refs:** SCHEMA.md §Forge, API.md §Forge, LAYERS.md §TaggedErrors, DESIGN_SYSTEM.md §5.9j, wireframes/forge-popover.html

## TASK FIELDS

### ✅ TASKF-1: Per-project customizable priority/type

Wireframes (kanban-settings-modal.html) show a "Priorities" + "Types" section in Board Settings so teams can customize the two task fields. Implementation previously used fixed enums (`urgent/high/medium/low`, `feature/bug/task/asset`) locked in SQL CHECK constraints, REST literals, and MCP enums.

**Backend:**
- [x] `migrations/0010_task_field_options.sql` — `priority_options`/`type_options` tables (project-scoped, ordered, unique label), backfill legacy 4+4 per project, rewrite `tasks.priority`/`type` to option IDs
- [x] `server/repos/field-config.repo.ts` — CRUD + list replace + `seedDefaults` + `countTasksUsing`
- [x] `server/services/field-config.service.ts` — full-replace PUT validation (dupes, empty, unknown ids → `INVALID_OPTION`; used-option delete → `OPTION_IN_USE`)
- [x] `server/api/errors.ts` — `OptionInUse` (409), `InvalidOption` (422) + catalog entries
- [x] `server/api/http.ts` — `GET/PUT /api/projects/:slug/field-config`, `/board` carries `fieldConfig`, task create/update accept option ids
- [x] `server/services/task.service.ts` + `task.repo.ts` — option-id create/update; defaults to first option; dashboard urgency = first priority option
- [x] `server/services/project.service.ts` — seeds default options on project create
- [x] MCP — `get_project` lists priorities/types; `create_task`/`update_task`/`list_tasks` take labels (case-insensitive) and return labels + ids

**Frontend:**
- [x] `shared/types.ts` + `shared/db.ts` — `FieldOption`/`FieldConfig`, `Task.priority`/`type` = option ids
- [x] `app/lib/api.ts` + `queries.ts` — `getFieldConfig`/`updateFieldConfig` hooks
- [x] `app/components/kanban/KanbanSettingsModal.tsx` — Priorities + Types sections (drag-reorder, add/edit/delete via `OptionForm`)
- [x] `app/components/kanban/OptionForm.tsx` — label + color swatch modal
- [x] `TaskCard.tsx`, `BoardFilters.tsx`, `Column.tsx`, `TaskDetail.tsx` — render options from `board.fieldConfig`

**Refs:** SCHEMA.md §Task field options, API.md §Field Config, MCP.md §get_project/create_task, DESIGN_SYSTEM.md §5.9i, wireframes/kanban-settings-modal.html

## DASHBOARD

### ✅ DASH-1: Replace dashboard stubs with real health aggregation

All dashboard data (`app/lib/dashboard-stubs.ts`) is random `charCodeAt` math. Replace with real `GET /api/dashboard` backend.

**Backend:**
- [x] `server/repos/task.repo.ts` — add `countByProject`, `countUrgent`, `countOutOfSync`, `countByColumn`, `findUrgentAcrossAllProjects`, `findOutOfSyncAcrossAllProjects` queries
- [x] `server/services/dashboard.service.ts` — new service: aggregate health per project, derive wipSegments, collect urgent/outOfSync lists
- [x] `server/api/http.ts` — register `GET /api/dashboard` endpoint, returns `Dashboard` type per API.md
- [x] `shared/types.ts` — add `ProjectHealth`, `Dashboard` types

**Frontend:**
- [x] `app/lib/api.ts` — add `getDashboard()` fetch function
- [x] `app/lib/queries.ts` — add `useDashboard()` query hook
- [x] `app/routes/index.tsx` — replace stubs with real data from `useDashboard()`
- [x] `app/routes/__root.tsx` — remove `stubTaskCount` usage
- [x] `app/lib/dashboard-stubs.ts` — **deleted**

**Refs:** API.md §Projects, DESIGN_SYSTEM.md §5.9

### ✅ DASH-2: Add ⋯ settings button on project cards

Wireframe `dashboard.html:63` — Void Drifter card has `⋮` (MoreHorizontal) button at top-right opening project settings modal (name, description, GitHub repo, delete). Current implementation: entire card is a `<Link>` to board — no settings access from dashboard.

- [x] `app/components/ProjectCard.tsx` — add `MoreHorizontal` button, stopPropagation on click
- [x] Open project settings modal (name, Description, GitHub Repo fields, Save + Delete buttons)
- [x] Wire edit: call `PATCH /api/projects/:slug` via `useUpdateProject` mutation
- [x] Wire delete: show confirm dialog, call `DELETE /api/projects/:slug`
- [x] `server/api/http.ts` — added missing `PATCH /api/projects/:slug` endpoint (wasn't implemented)
- [x] `app/lib/api.ts` — add `updateProject()` function
- [x] `app/lib/queries.ts` — add `useUpdateProject()` mutation
- [x] `app/styles/phosphor.css` — add `.dashboard-settings-btn` hover-reveal CSS

**Refs:** `wireframes/src/dashboard.html:63`, `wireframes/src/dashboard-new-project.html`, `wireframes/src/dashboard-delete-project.html`

### ✅ DASH-3: Create flow — inline input → modal

Wireframe shows "New Project" → modal with Name, Description, GitHub Repo fields → Create. Current: inline text input + confirm dialog → creates name-only.

- [x] `app/routes/index.tsx` — replaced inline form with "New Project" button opening modal, removed confirm dialog
- [x] `app/lib/api.ts` — updated `createProject` to accept `description` and `githubRepo`
- [x] `app/styles/phosphor.css` — added `.field` CSS for modal field spacing

**Refs:** `wireframes/src/dashboard-new-project.html`

### ✅ DASH-4: `shared/types.ts` — sync with API.md

`Swimlane` type in `shared/types.ts` has `description: string` field not present in API.md's `Swimlane` interface. Remove or reconcile.

- [x] Check if description is used anywhere in MCP or repo code
- [x] If used, add to API.md; if not, remove from `shared/types.ts`

### ✅ DASH-5: Dashboard CSS — health card footer flex dependency

`.health-card-footer` uses `margin-top: auto` which requires parent `display: flex; flex-direction: column`. `.project-card` provided this, `.health-card` overrode dimensions — now `.health-card` has explicit `display: flex; flex-direction: column`.

---

## KANBAN

### ✅ KAN-1: Inline add-task form missing

Wireframe `kanban-inline-add.html` shows compact inline form (title input, priority chips, type chips, Cancel/Save) replacing "+ Add task..." button. Implementation skips — clicking "+" opens full slideover create mode. Inline form is primary lightweight creation path per wireframes.

- [x] `app/components/kanban/Column.tsx` — added inline form with title input, Priority/Type dropdowns (Full-width selects, 140px max), Cancel/Save, Enter/Esc handling
- [x] `app/components/kanban/KanbanBoard.tsx` — pass `slug`, `columnId`, `swimlaneId` props to Column

**Refs:** `wireframes/src/kanban-inline-add.html`

### ✅ KAN-2: Swimlane description not shown on board

Wireframe shows truncated description text + "read more" in every swimlane header. `SwimlaneHeader.tsx` had zero description rendering. Description modal also missing.

- [x] `SwimlaneHeader.tsx` — renders `lane.description` truncated to ~80 chars with "read more" link
- [x] Added description modal (dialog with full text, close button)
- [x] CSS `.swimlane-desc` and `.swimlane-desc-more` already existed in phosphor.css

**Refs:** `wireframes/src/kanban-swimlane-menu.html:34-36`, `wireframes/src/kanban-swimlane-desc-modal.html`

### ✅ KAN-3: Swimlane description editor is plain textarea, not TipTap

Wireframe previously showed TipTap editor. Decision: keep plain textarea — schema is `TEXT`. Wireframe updated. Description modal renders Markdown (`**bold**`, `*italic*`, `` `code` ``, `- lists`).

- [x] `wireframes/src/kanban-swimlane-settings-modal.html` — replaced TipTap mockup with `<textarea>`, added impl note
- [x] `SwimlaneHeader.tsx` — added `renderSwimlaneDesc()` markdown renderer for "read more" modal
- [x] `SwimlaneForm.tsx` — already uses `<textarea>`, no change needed

### ✅ KAN-4: Column/board settings menus all disabled

`ColumnHeader.tsx` has Rename, Edit column, Delete, Clear all tasks all `disabled`. `SwamaneHeader.tsx` has Rename, Add column, Delete swimlane all `disabled`.

- [x] `ColumnHeader.tsx` — enabled Rename (inline input), Edit column (ColumnForm modal), Delete (confirmation dialog), Clear tasks (bulk delete with confirmation)
- [x] `SwamaneHeader.tsx` — enabled Rename (inline input), Add column (ColumnForm create), Delete (confirmation dialog)
- [x] `KanbanBoard.tsx` — updated call sites to pass `slug`, `column`/`lane` props

### ✅ KAN-5: Swimlane menu missing "Settings" entry

Wireframe shows "Settings" (opens swimlane settings modal) as first menu item. Implementation menu only shows Expand/Collapse, Rename (disabled), Add column (disabled), Delete (disabled).

- [x] `SwamaneHeader.tsx` — added "Settings" (Gear icon) entry before separator, opens SwimlaneForm modal

**Refs:** `wireframes/src/kanban-swimlane-menu.html`

### ✅ KAN-6: No task description editing in slideover

Wireframe annotation: "Double-click description → opens task-detail-edit.html (Tiptap editor inline)". `TaskDetail.tsx` view mode renders description as readonly prose. No double-click-to-edit on description.

- [x] `TaskDetail.tsx` — added `editingDescription` state, double-click on `.td-prose` toggles `DescriptionEditor`, saves on blur

**Refs:** `wireframes/src/task-detail-edit.html`

### ✅ KAN-7: ColumnForm color palette incomplete

Wireframe shows 12 colors. Implementation has only 6 (None, Amber, Green, Cyan, Red, Pink). Missing: Zinc, Orange, Lime, Emerald, Blue, Indigo, Violet.

- [x] `ColumnForm.tsx` — added Zinc, Orange, Lime, Emerald, Blue, Indigo, Violet (now 13 colors)

**Refs:** `wireframes/src/kanban-column-settings-modal.html`

### ✅ KAN-8: No drag-to-reorder for columns/swimlanes in board settings

Wireframe shows grip handles for drag reordering. Dnd-kit renders `GripVertical` as decoration — no DnD wired.

- [x] `KanbanSettingsModal.tsx` — wired `DndContext` + `SortableContext` + `SortableRow` for both columns and swimlanes tables. Drag reorder syncs `position` via `updateColumn.mutate`/`updateSwamane.mutate` on drop. 5px activation distance prevents accidental drags.

**Refs:** `wireframes/src/kanban-settings-modal.html`

### ✅ KAN-9: ColumnForm submit ignores githubState

`ColumnForm` collects `githubState` but `KanbanSettingsModal.tsx` never passes it to `createColumn`/`updateColumn`. Wireframe has GitHub State Mapping as primary field.

- [x] `KanbanSettingsModal.tsx` — pass `githubState` in create/update column calls

**Refs:** `wireframes/src/kanban-column-settings-modal.html`

### ✅ KAN-10: Delete column/swimlane has no confirmation dialog

Wireframe annotation says delete opens confirmation dialog. Implementation calls `deleteColumn.mutate`/`deleteSwamane.mutate` directly.

- [x] `KanbanSettingsModal.tsx` — added confirm dialog before delete column/swimlane ("Delete 'X'?" + "This will remove all tasks" / "This will unassign all tasks")

### ✅ KAN-11: Column menu differs from wireframe

Wireframe shows: Add task, Settings (gear → ColumnForm modal), separator, Delete, Clear all tasks. Implementation had: Add task, Rename, Edit column, separator, Delete, Clear. Merged Rename + Edit column into single "Settings" entry per wireframe.

- [x] `app/components/kanban/ColumnHeader.tsx` — removed Rename entry + inline rename code, "Edit column" → "Settings" with gear icon, cleaned unused imports

### ✅ KAN-12: Empty board "Add Column" opens wrong modal

Wireframe expects column create modal directly. Implementation opens full Board Settings modal.

- [x] `KanbanBoard.tsx` — added standalone ColumnForm modal, "Add Column" in empty state opens it directly

**Refs:** `wireframes/src/kanban-empty.html`

### ✅ KAN-13: Required field options don't match API

`ColumnForm.tsx` lists Type, Assignee, Description. API.md says `requiredFields: subset of ["title","description","assignee"]`. "Type" doesn't exist in API spec. Wireframe shows Title, Description, Assignee.

- [ ] `ColumnForm.tsx` — replace "Type" with "Title" in required fields

**Refs:** `wireframes/src/kanban-column-settings-modal.html`

### 🟢 KAN-14: TaskDetail GitHub link uses setTimeout mock (DEFERRED)

Implementation has UI states wired but "Create issue" action is `setTimeout(Math.random)` mock. GitHub integration backend returns `NOT_IMPLEMENTED` in MCP — no REST endpoint exists. Deferred until GitHub integration is built.

### 🟢 KAN-15: No responsive layout (DEFERRED)

Wireframe describes responsive collapse at 1280px (single-column stack) and 768px (swimlane tabs, full-width cards, full-screen slideover, hamburger nav). Major restructuring needed. Deferred until scope defined.

### ✅ KAN-16: TaskDetail column selector is native select vs custom dropdown

Wireframe shows custom dropdown popovers with checkmarks. Implementation uses native `<select>`.

- [x] `TaskDetail.tsx` — replaced native `<select>` with `SelectDropdown` + `ChevronDown` icon per existing Priority/Type pattern

### ✅ KAN-17: Card type colors — verify CSS vars match wireframe hex values

Wireframe Bug type uses `#FF4444`. Implementation uses CSS variables. All type badge colors verified:

- feature: `#4ADE80` ✅ `--lx-badge-feature: #15803D` (text), `rgba(74, 222, 128, 0.10)` (bg) ✅
- bug: `#FF4444` ✅ `--lx-badge-bug: #991B1B` (text), `rgba(255, 68, 68, 0.10)` (bg) ✅
- task: `#67E8F9` ✅ `--lx-badge-task: #0E7490` (text), `rgba(34, 211, 238, 0.10)` (bg) ✅
- asset: `#F9A8D4` ✅ `--lx-badge-asset: #BE185D` (text), `rgba(244, 114, 182, 0.10)` (bg) ✅

Wireframe and implementation match.

### ✅ KAN-18: Task archive feature

Archive tasks from the kanban (card kebab ⋮ and TaskDetail footer). Archive is reversible; no requirement on which tasks can be archived; delete stays untouched.

- [x] `migrations/0009_task_archive.sql` — `tasks.archived_at` (NULL = live, timestamp = archived)
- [x] `shared/types.ts` + `shared/db.ts` — `Task.archivedAt`, `TaskRow.archived_at`, `rowToTask` mapping
- [x] `server/repos/task.repo.ts` — `setArchived`; `findAllByProject`/`findByProject` `includeArchived`; WIP count / `findLastInColumn` / dashboard aggregates exclude archived
- [x] `server/services/task.service.ts` — `archive`/`restore` (idempotent, no GitHub dependency)
- [x] `server/api/http.ts` — `POST /tasks/:id/archive`, `POST /tasks/:id/restore`, `GET /board?includeArchived`
- [x] `server/mcp/` — `archive_task`, `restore_task` tools; `list_tasks includeArchived`; taskId auth list extended
- [x] `app/lib/api.ts` + `app/lib/queries.ts` — `archiveTask`/`restoreTask`, `useBoard(slug, includeArchived)`, `useArchiveTask`/`useRestoreTask` with both board-variant cache updates
- [x] `app/components/kanban/TaskCard.tsx` + `KanbanBoard.tsx` — card kebab (Archive/Restore/Delete), "Show archived" toggle, archived cards dimmed + non-draggable
- [x] `app/components/TaskDetail.tsx` — Archive/Restore footer button + archived notice banner
- [x] Wireframes — `kanban.html` (toggle, kebab, archived card state + annotations), `task-detail.html` (Restore footer, archived notice), `wireframes.css` (`.state-archived`, `.archived-tag`)
- [x] Docs: SCHEMA.md, API.md, MCP.md, LAYERS.md, IMPLEMENTATION.md
- [x] Tests: 66/66 pass; wireframes build clean

**Refs:** `wireframes/src/kanban.html`, `wireframes/src/task-detail.html`

---

### ✅ ARCH-1: Task model single-assignee → multi-assignee

Every wireframe card shows stacked avatars with overflow counter. Schema had `assignee TEXT` — single freeform string. Migrated to `task_assignees(task_id, user_name)` junction table.

- [x] `migrations/0002_multi_assignee.sql` — CREATE task_assignees, migrate existing data, DROP old column
- [x] `shared/db.ts` + `shared/types.ts` — `assignee: string|null` → `assignees: string[]`
- [x] `server/repos/task.repo.ts` — all SELECTs: LEFT JOIN + GROUP_CONCAT; create/update: INSERT/DELETE assignees; filter: EXISTS subquery
- [x] `server/services/task.service.ts` — validate required fields: check array emptiness
- [x] `server/api/http.ts` — TaskSchema/CreatePayload/UpdatePayload: `assignees: Schema.Array(Schema.String)`
- [x] `server/mcp/tools/` — all tools updated: array schema for create/update, array output
- [x] `app/lib/api.ts` + `app/lib/queries.ts` — signatures: `assignees?: string[]`
- [x] `app/components/kanban/TaskCard.tsx` — stacked avatars (max 3, +N overflow)
- [x] `app/components/TaskDetail.tsx` — AssigneeChips (multi-select with remove)
- [x] `app/components/kanban/BoardFilters.tsx` — flatMap for assignee collection, unassigned check
- [x] `app/components/kanban/KanbanBoard.tsx` — `cardProps.assignees`, filter logic
- [x] `app/routes/$slug/index.tsx` — availableAssignees from `flatMap`
- [x] Docs: SCHEMA.md, API.md, MCP.md, LAYERS.md — all updated

### ✅ ARCH-2: Task model single GitHub issue → multi-issue

Wireframe cards show multiple GitHub badges + overflow. Schema had single `github_issue_id TEXT UNIQUE` — one task ↔ one issue. Migrated to `task_github_issues(task_id, issue_id, issue_number, repo, synced_state)` junction table.

- [x] `migrations/0006_multi_github_issues.sql` — CREATE task_github_issues, migrate existing data
- [x] `shared/types.ts` — `GithubIssue` interface, `Task.github` → `Task.githubs: GithubIssue[]`
- [x] `shared/db.ts` — `rowToTask` parses GROUP_CONCAT'd raw string into `GithubIssue[]`
- [x] `server/repos/task.repo.ts` — all SELECTs: LEFT JOIN task_github_issues + columns; new `unlinkGithubIssue`; updated `setGithubSyncedState`/`moveFromWebhook`/`findByGithubIssue`/`countOutOfSync` (DISTINCT)
- [x] `server/api/http.ts` — `GithubIssueSchema`, `TaskSchema.githubs`
- [x] `server/mcp/tools/` — all tools: `githubIssues` array; `unlink-github-issue` adds `issueId` param
- [x] `app/components/kanban/TaskCard.tsx` — stacked badges (max 2 + overflow), sync dot
- [x] `app/components/TaskDetail.tsx` — multi-issue list with per-row sync status + unlink
- [x] `app/components/kanban/KanbanBoard.tsx` — `cardProps.githubs`
- [x] Docs: SCHEMA.md, API.md, MCP.md — all updated

---

## MCP

### ✅ MCP-1: `get_project_status` — documented as deliberately simpler

`get_project_status` returns `{ columns: [{ name, count, wipLimit }], totalTasks }` — a lightweight agent tool for WIP headroom checks before batch moves. Dashboard health aggregation (urgent count, sync status, overall health) is the REST `GET /api/dashboard` endpoint — separate surface. Note added to MCP.md.

**Refs:** MCP.md §Tools

---

## DOCS

### ✅ DOCS-1: LAYERS.md — DashboardService added

- [x] `DashboardService` added to LAYERS.md service dependency map: `DashboardService → TaskRepo, ColumnRepo, ProjectRepo`

### ✅ DOCS-2: MCP.md `get_project_status` note

- [x] Added note: lightweight agent tool; dashboard health aggregation is the REST `GET /api/dashboard` endpoint (separate surface).

---

## CONSTRAINTS

### ✅ SWIM-1: Tasks must belong to both column AND swimlane

Wireframe annotation: "every task must belong to a column AND a swimlane. Tasks without a swimlane are not allowed. Column is a template — rendered inside each swimlane row."

- [x] `migrations/0007_swimlane_required.sql` — auto-creates default swimlane, reassigns orphans, ALTER TABLE NOT NULL
- [x] `scripts/seed-dev.sql` — 3 NULL tasks assigned to Core swimlane
- [x] `server/services/project.service.ts` — new projects get "Default" swimlane alongside 5 default columns
- [x] `shared/types.ts` + `shared/db.ts` — `swimlaneId: string` (not nullable)
- [x] `server/repos/task.repo.ts` — `swimlaneId: string` in create/move
- [x] `server/services/task.service.ts` — `swimlaneId: string` (required)
- [x] `server/api/http.ts` — CreateTaskPayload + MoveTaskPayload: `swimlaneId` required
- [x] `server/mcp/tools/create-task.ts` — swimlane parameter required
- [x] `server/mcp/tools/move-task.ts` — keeps original task.swimlaneId
- [x] `app/components/kanban/KanbanBoard.tsx` — removed null-lane row, `?? null` coalescing
- [x] `app/components/kanban/Column.tsx` + `app/lib/api.ts` + `app/lib/queries.ts` + `app/routes/$slug/index.tsx` — `string`, not nullable
- [x] Docs: SCHEMA.md, API.md, MCP.md — all updated
- [x] Wireframe: annotation added to kanban.html
- [x] Tests: 65/65 pass, tsc clean

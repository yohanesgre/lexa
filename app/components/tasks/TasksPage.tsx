import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useBoard,
  useTask,
  useTasks,
  useMoveTask,
  useUpdateTask,
  useCreateTask,
  useDeleteTask,
  useArchiveTask,
  useRestoreTask,
  useLinkGithubIssue,
  useUnlinkGithubIssue,
  useCapabilities,
  useBulkTaskAction,
} from "../../lib/queries";
import type { BulkTaskActionInput } from "../../lib/api";
import { parseSwimlaneParam } from "../../lib/filters";
import type { TaskListItem } from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { TaskDetail } from "../TaskDetail";
import { Menu } from "../ui/Menu";
import { DatePicker } from "../ui/DatePicker";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { cn } from "../ui/cn";
import type { MoveTarget } from "../kanban/KanbanBoard";
import type { Task, TipTapDoc, FieldConfig, Column, Swimlane } from "../../../shared/types";

type SortKey = "board" | "priority" | "created";

// Ticket-key pattern: project prefix (2–6 chars) + dash + number — e.g. "EG-12".
const KEY_PATTERN = /^[A-Z0-9]{2,6}-\d+$/i;

const CHECK_PATH = "M20 6L9 17l-5-5";
const DASH_PATH = "M5 12h14";

interface TasksFilters {
  query: string;
  columnId: string;
  typeId: string;
  priorityId: string;
  assignee: string;
  swimlaneId: string;
  sortKey: SortKey;
}

function hasActiveTaskFilters(f: TasksFilters) {
  return f.query !== "" || f.columnId !== "" || f.typeId !== "" || f.priorityId !== "" || f.assignee !== "" || f.swimlaneId !== "";
}

function findExactKeyMatchId(query: string, tasks: TaskListItem[] | null | undefined) {
  const q = query.trim();
  if (!KEY_PATTERN.test(q)) return null;
  return tasks?.find((t) => t.key.toLowerCase() === q.toLowerCase())?.id ?? null;
}

function filterAndSortTasks(
  tasks: TaskListItem[],
  filters: TasksFilters,
  showArchived: boolean,
  fieldConfig: FieldConfig | undefined,
  exactMatchId: string | null,
): TaskListItem[] {
  const { query, columnId, typeId, priorityId, assignee, swimlaneId, sortKey } = filters;
  let list = tasks;
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q));
  if (columnId) list = list.filter((t) => t.columnId === columnId);
  if (typeId) list = list.filter((t) => t.typeId === typeId);
  if (priorityId) list = list.filter((t) => t.priorityId === priorityId);
  if (assignee) list = list.filter((t) => t.assignees.includes(assignee));
  if (swimlaneId) list = list.filter((t) => t.swimlaneId === swimlaneId);
  if (showArchived) list = list.filter((t) => t.archivedAt !== null);
  const priorityPos = new Map((fieldConfig?.priorities ?? []).map((o) => [o.id, o.position]));
  if (sortKey === "priority") {
    list = list.toSorted((a, b) => (priorityPos.get(a.priorityId) ?? 999) - (priorityPos.get(b.priorityId) ?? 999));
  } else if (sortKey === "created") {
    list = list.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  // Key-pattern search: surface the exact key match first (server pre-checks the same way).
  if (exactMatchId) {
    const idx = list.findIndex((t) => t.id === exactMatchId);
    if (idx > 0) {
      list = [...list]; // never mutate the cached tasks array
      const [exact] = list.splice(idx, 1);
      list = [exact!, ...list];
    }
  }
  return list;
}

async function runTaskMutation(fn: () => Promise<unknown>, after?: () => void) {
  try {
    await fn();
    after?.();
  } catch {
    // error toast comes from the mutation
  }
}

function findLinkedIssue(task: { githubs: { repo: string; issueNumber: number }[] }, repo: string) {
  const linked = task.githubs.find((g) => g.repo === repo);
  return linked ? { repo: linked.repo, issueNumber: linked.issueNumber } : null;
}

function resolveSelectedTask(
  full: Task | undefined,
  boardTasks: Task[] | undefined,
  selectedTaskId: string | null,
) {
  if (!selectedTaskId) return null;
  return full ?? boardTasks?.find((t) => t.id === selectedTaskId) ?? null;
}

function TasksErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="tasks-error">
        <div className="tasks-error-title">Failed to load tasks</div>
        <div className="tasks-error-sub">
          <span className="font-mono">Network error</span> — the board query failed to load
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </main>
  );
}

const SKELETON_ROW_WIDTHS = ["55%", "49%", "58%", "43%", "52%"];

function TasksSkeleton() {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="tasks-page">
        <div className="tasks-header">
          <div>
            <div className="skeleton" style={{ width: 140, height: 22 }} />
            <div className="skeleton mt-2" style={{ width: 96, height: 12 }} />
          </div>
        </div>
        <div className="tasks-filter">
          <div className="skeleton" style={{ flex: 1, minWidth: 200, height: 28 }} />
          {[100, 88, 96, 104, 100, 112].map((width, i) => (
            <div key={i} className="skeleton" style={{ width, height: 28 }} />
          ))}
          <div className="skeleton" style={{ width: 76, height: 28 }} />
        </div>
        <div className="tasks-list">
          {SKELETON_ROW_WIDTHS.map((width) => (
            <div key={width} className="card-row">
              <div className="skeleton" style={{ width, height: 14 }} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export interface TasksPageProps {
  slug: string;
  search: { task?: string | undefined; swimlane?: string | undefined; new?: boolean | undefined };
}

function SelectBox({ checked, mixed, label, disabled, onClick }: {
  checked: boolean;
  mixed: boolean;
  label: string;
  disabled?: boolean | undefined;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="task-selectbox"
      role="checkbox"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
        <path d={mixed ? DASH_PATH : CHECK_PATH} />
      </svg>
    </button>
  );
}

function TaskRow({ task, bulkEnabled, selected, swimlaneId, swimlanes, exactMatchId, onToggleSelect, onSelect }: {
  task: TaskListItem;
  bulkEnabled: boolean;
  selected: boolean;
  swimlaneId: string;
  swimlanes: Swimlane[];
  exactMatchId: string | null;
  onToggleSelect: (taskId: string, shiftKey: boolean) => void;
  onSelect: (t: TaskListItem) => void;
}) {
  return (
    <div
      className={cn("card-row", task.archivedAt && "archived", selected && "state-selected")}
      style={task.priorityColor !== "" ? { borderLeft: `3px solid ${task.priorityColor}` } : undefined}
    >
      {bulkEnabled && (
        <SelectBox
          checked={selected}
          mixed={false}
          label={`${selected ? "Deselect" : "Select"} ${task.key} ${task.title}`}
          onClick={(e) => onToggleSelect(task.id, e.shiftKey)}
        />
      )}
      <button
        type="button"
        className="task-row-open"
        aria-label={`Open ${task.key}: ${task.title}`}
        onClick={() => onSelect(task)}
      >
        <span className="task-key">{task.key}</span>
        <span className="task-row-title">{task.title}</span>
        <span className="task-row-meta">
          {swimlaneId && (
            <span className="task-row-where">
              <span className="task-chip gh">
                Sprint: {swimlanes.find((l) => l.id === swimlaneId)?.name ?? swimlaneId}
              </span>
            </span>
          )}
          <span className="task-row-where">
            {task.columnColor ? (
              <span
                className="task-row-where-chip"
                style={{ color: task.columnColor, background: `${task.columnColor}1a` }}
              >
                <span className="dot" style={{ background: task.columnColor }} />
                {task.columnName}
              </span>
            ) : (
              <span className="task-row-where-chip">{task.columnName}</span>
            )}
            <span>{task.swimlaneName}</span>
          </span>
          <span className="task-row-status">
            {task.id === exactMatchId && (
              <span className="task-chip gh">
                exact match
              </span>
            )}
            <span className="task-chip type" style={task.typeColor ? { color: task.typeColor, borderColor: task.typeColor } : undefined}>
              {task.typeLabel}
            </span>
            <span className="task-chip priority" style={task.priorityColor ? { color: task.priorityColor, borderColor: task.priorityColor } : undefined}>
              {task.priorityLabel}
            </span>
            {task.githubNumber !== null && <span className="task-gh">#{task.githubNumber}</span>}
            <span className="task-row-date">{task.createdAt.slice(0, 10)}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

type BulkActionInput = Omit<BulkTaskActionInput, "ids">;

function BulkActionBar({ count, archivedView, columns, swimlanes, fieldConfig, assigneeOptions, pending, onAction, onArchive, onRestore, onClear }: {
  count: number;
  archivedView: boolean;
  columns: Column[];
  swimlanes: Swimlane[];
  fieldConfig: FieldConfig | undefined;
  assigneeOptions: string[];
  pending: boolean;
  onAction: (input: BulkActionInput) => void;
  onArchive: () => void;
  onRestore: () => void;
  onClear: () => void;
}) {
  const triggerClass = "btn btn-ghost btn-sm";
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions" data-pending={pending ? "true" : undefined}>
      <span className="bulk-bar-count">{count} selected</span>
      <span className="bulk-bar-sep" />
      <Menu align="left" trigger={({ toggle }) => (
        <button type="button" className={triggerClass} onClick={toggle} disabled={pending}>Move to column…</button>
      )}>
        {columns.map((c) => (
          <button key={c.id} type="button" className="menu-item" onClick={() => onAction({ action: "move", columnId: c.id })}>
            {c.name}
          </button>
        ))}
      </Menu>
      <Menu align="left" trigger={({ toggle }) => (
        <button type="button" className={triggerClass} onClick={toggle} disabled={pending}>Move to sprint…</button>
      )}>
        {swimlanes.map((l) => (
          <button key={l.id} type="button" className="menu-item" onClick={() => onAction({ action: "move", swimlaneId: l.id })}>
            {l.name}
          </button>
        ))}
      </Menu>
      <Menu align="left" trigger={({ toggle }) => (
        <button type="button" className={triggerClass} onClick={toggle} disabled={pending}>Set assignee…</button>
      )}>
        {assigneeOptions.map((name) => (
          <button key={name} type="button" className="menu-item" onClick={() => onAction({ action: "update", assignees: [name] })}>
            {name}
          </button>
        ))}
      </Menu>
      <Menu align="left" trigger={({ toggle }) => (
        <button type="button" className={triggerClass} onClick={toggle} disabled={pending}>Set priority…</button>
      )}>
        {(fieldConfig?.priorities ?? []).map((o) => (
          <button key={o.id} type="button" className="menu-item" onClick={() => onAction({ action: "update", priority: o.id })}>
            <span className="priority-dot" style={{ background: o.color }} />
            {o.label}
          </button>
        ))}
      </Menu>
      <DatePicker
        value={null}
        placeholder="Set due date…"
        onChange={(v) => { if (v) onAction({ action: "update", dueAt: v }); }}
      />
      <span className="bulk-bar-spacer" />
      {archivedView ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRestore} disabled={pending}>Restore</button>
      ) : (
        <button type="button" className="btn btn-danger btn-sm" onClick={onArchive} disabled={pending}>Archive</button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" aria-label="Clear selection" onClick={onClear} disabled={pending}>Clear</button>
    </div>
  );
}

function confirmVerb(kind: "archive" | "restore") {
  return kind === "archive" ? "Archive" : "Restore";
}

function pluralTasks(n: number) {
  return n === 1 ? "task" : "tasks";
}

function keySummary(keys: string[]) {
  const shown = keys.slice(0, 3);
  if (keys.length > 3) return `${shown.join(", ")} +${keys.length - 3} more`;
  if (shown.length <= 1) return shown.join("");
  // Wireframe: two keys read "EG-25 and EG-18" (tasks.html:385).
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

export function TasksPage({ slug, search }: TasksPageProps) {
  const navigate = useNavigate();
  const toast = useToast();

  const [showArchived, setShowArchived] = useState(false);
  const [filters, setFilters] = useState({
    query: "",
    columnId: "",
    typeId: "",
    priorityId: "",
    assignee: "",
    swimlaneId: parseSwimlaneParam(search.swimlane),
    sortKey: "board" as SortKey,
  });
  const setFilter = (patch: Partial<typeof filters>) => setFilters((s) => ({ ...s, ...patch }));

  const { query, columnId, typeId, priorityId, assignee, swimlaneId, sortKey } = filters;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<"archive" | "restore" | null>(null);

  // Keep the filter in sync when the ?swimlane= param changes while mounted
  // (e.g. "View tasks" links from the swimlanes page while already here).
  useEffect(() => {
    setFilter({ swimlaneId: parseSwimlaneParam(search.swimlane) });
  }, [search.swimlane]);

  const { board, tasks, isLoading, error, refetch } = useTasks(slug, showArchived);
  const boardQuery = useBoard(slug, showArchived);
  const columns = boardQuery.data?.columns ?? [];
  const swimlanes = boardQuery.data?.swimlanes ?? [];
  const fieldConfig = boardQuery.data?.fieldConfig;
  const assigneeOptions = useMemo(() => [...new Set((board?.tasks ?? []).flatMap((t) => t.assignees))].sort(), [board]);

  const moveTask = useMoveTask(slug);
  const updateTask = useUpdateTask(slug);
  const createTask = useCreateTask(slug);
  const deleteTask = useDeleteTask(slug);
  const archiveTask = useArchiveTask(slug);
  const restoreTask = useRestoreTask(slug);
  const linkGithubIssue = useLinkGithubIssue(slug);
  const unlinkGithubIssue = useUnlinkGithubIssue(slug);

  const capabilities = useCapabilities();
  // Kill switch: `tasksBulk:false` disables selection entirely; an absent field
  // (older build) means enabled (default-on). Gate on isFetched so the switch
  // settles before first paint — controls never flash on then off.
  const bulkEnabled = capabilities.isFetched && capabilities.data?.tasksBulk !== false;
  const bulk = useBulkTaskAction(slug);

  const hasActiveFilters = hasActiveTaskFilters(filters);

  // Key-pattern search: the task whose key matches the query exactly.
  const exactMatchId = useMemo(() => findExactKeyMatchId(query, tasks), [query, tasks]);

  const filtered = useMemo(
    () => filterAndSortTasks(tasks ?? [], filters, showArchived, fieldConfig, exactMatchId),
    [tasks, filters, showArchived, fieldConfig, exactMatchId],
  );

  const keyById = useMemo(() => new Map((board?.tasks ?? []).map((t) => [t.id, t.key])), [board]);
  const selectedCount = selectedIds.size;

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  // Deleting/archiving from the detail removes the row from the live list, so
  // its id must not linger in the selection.
  const dropSelected = (id: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Selection is scoped to the filtered result: changing a filter, the sort, or
  // the archived toggle clears it (ids can fall out of the result set).
  const filterSignature = `${query}|${columnId}|${typeId}|${priorityId}|${assignee}|${swimlaneId}|${sortKey}|${showArchived}`;
  useEffect(() => {
    setSelectedIds(new Set());
    setAnchorId(null);
  }, [filterSignature]);

  const filteredIds = useMemo(() => filtered.map((t) => t.id), [filtered]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someSelected = filteredIds.some((id) => selectedIds.has(id));
  const selectAllState = allSelected ? "true" : someSelected ? "mixed" : "false";
  const selectAllLabel = allSelected
    ? (showArchived ? "Deselect all archived tasks" : "Deselect all tasks")
    : someSelected
      ? `Select all tasks — ${selectedCount} of ${filteredIds.length} selected`
      : hasActiveFilters
        ? `Select all ${filteredIds.length} matching tasks`
        : "Select all tasks";

  const toggleSelect = (taskId: string, shiftKey: boolean) => {
    const anchorIndex = anchorId !== null ? filteredIds.indexOf(anchorId) : -1;
    const targetIndex = filteredIds.indexOf(taskId);
    const isRange = shiftKey && anchorIndex >= 0 && targetIndex >= 0;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isRange) {
        const targetState = !prev.has(taskId);
        const [lo, hi] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        for (let i = lo; i <= hi; i++) {
          const id = filteredIds[i]!;
          if (targetState) next.add(id);
          else next.delete(id);
        }
        return next;
      }
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
    // Shift-click keeps the anchor; a plain click (or a range-less shift) moves it.
    if (!isRange) setAnchorId(taskId);
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filteredIds.every((id) => prev.has(id))) {
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      for (const id of filteredIds) next.add(id);
      return next;
    });
    setAnchorId(null);
  };

  const runBulk = async (input: BulkActionInput) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const res = await bulk.mutateAsync({ ids, ...input });
      if (res.failed.length === 0) {
        clearSelection();
        return;
      }
      // Partial failure: failed rows stay selected, permitted tasks applied.
      const failedIds = new Set(res.failed.map((f) => f.id));
      setSelectedIds(new Set(ids.filter((id) => failedIds.has(id))));
      setAnchorId(null);
      const reasons = res.failed
        .map((f) => `${keyById.get(f.id) ?? f.id}: ${f.message}`)
        .join(", ");
      toast.push("error", `${res.failed.length} ${pluralTasks(res.failed.length)} not updated`, reasons);
    } catch {
      // request/network failure: the mutation toasts; nothing changes
    }
  };

  const clearFilters = () => {
    // Search + dropdowns only — the sort key and archived toggle are preserved
    // (wireframes/src/tasks.html:234).
    setFilters((s) => ({ ...s, query: "", columnId: "", typeId: "", priorityId: "", assignee: "", swimlaneId: "" }));
    navigate({ search: { swimlane: undefined }, replace: true } as never);
  };

  const selectedTaskId = search.task ?? null;
  const isCreating = search.new === true;
  const { data: selectedTaskFull } = useTask(slug, selectedTaskId);
  const selectedTask = resolveSelectedTask(selectedTaskFull, boardQuery.data?.tasks, selectedTaskId);
  const defaultBacklogId = swimlanes.find((l) => l.kind === "backlog")?.id;

  const handleMove = async (taskId: string, target: MoveTarget) => {
    await moveTask.mutateAsync({ id: taskId, ...target });
  };
  const handleUpdate = (id: string, data: Partial<Task>) => {
    updateTask.mutate({ id, ...data });
  };
  const handleDelete = (id: string) => runTaskMutation(
    () => deleteTask.mutateAsync({ id }),
    () => {
      dropSelected(id);
      navigate({ search: { task: undefined }, replace: true } as never);
    },
  );
  const handleArchive = (id: string) => runTaskMutation(
    () => archiveTask.mutateAsync({ id }),
    () => {
      dropSelected(id);
      navigate({ search: { task: undefined }, replace: true } as never);
    },
  );
  const handleRestore = (id: string) => runTaskMutation(() => restoreTask.mutateAsync({ id }));
  const handleLinkGithub = async (id: string, repo: string) => {
    const { data: task } = await linkGithubIssue.mutateAsync({ id, repo });
    return findLinkedIssue(task, repo);
  };
  const handleUnlinkGithub = async (id: string, issueId: string) => {
    await unlinkGithubIssue.mutateAsync({ id, issueId });
  };
  const handleSelectTask = (task: TaskListItem) => {
    navigate({ search: { task: task.id }, replace: true } as never);
  };
  const handleClose = () => {
    navigate({ search: { task: undefined, new: undefined }, replace: true } as never);
  };
  const handleOpenCreate = () => {
    navigate({ search: { new: true }, replace: true } as never);
  };
  const handleCreate = async (input: {
    title: string;
    columnId: string;
    priority: string;
    type: string;
    assignees: string[];
    description: TipTapDoc;
    dueAt?: string | null | undefined;
    swimlaneId?: string | undefined;
  }) => {
    await createTask.mutateAsync({
      title: input.title,
      columnId: input.columnId,
      priority: input.priority,
      type: input.type,
      assignees: input.assignees,
      description: input.description,
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.swimlaneId !== undefined ? { swimlaneId: input.swimlaneId } : {}),
    });
  };
  const handleListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") clearSelection();
  };

  if (isLoading) {
    return <TasksSkeleton />;
  }
  if (error) {
    return <TasksErrorState onRetry={() => refetch()} />;
  }
  if (!board || !tasks) return <main className="page-frame page-frame-narrow"><div className="tasks-error">Project not found</div></main>;

  const emptyProject = board.tasks.length === 0;
  const confirmKeys = [...selectedIds].map((id) => keyById.get(id) ?? id);

  return (
    <main className="page-frame page-frame-narrow">
      <div className="tasks-page">
        <div className="tasks-header">
          <div>
            <h1 className="tasks-title">Tasks</h1>
            <div className="tasks-sub">
              {board.project.name} · {board.tasks.filter((t) => t.archivedAt === null).length} total
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleOpenCreate}
            disabled={createTask.isPending}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 5v14m-7-7h14" /></svg>
            New task
          </button>
        </div>

      <TasksFilterBar
        filters={filters}
        showArchived={showArchived}
        columns={columns}
        swimlanes={swimlanes}
        fieldConfig={fieldConfig}
        assigneeOptions={assigneeOptions}
        onFilterChange={setFilter}
        onShowArchivedChange={setShowArchived}
        onSwimlaneChange={(v) => {
          setFilter({ swimlaneId: v });
          navigate({ search: { swimlane: v || undefined }, replace: true } as never);
        }}
      />

      {emptyProject ? (
        <div className="tasks-empty">
          <div className="tasks-empty-title">No tasks yet</div>
          <div className="tasks-empty-sub">Create tasks from the board, or use New task above.</div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate({ to: "/$slug/board", params: { slug } } as never)}>
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
        <>
          {bulkEnabled && (
            <div className="tasks-list-head">
              <SelectBox
                checked={allSelected}
                mixed={someSelected && !allSelected}
                label={selectAllLabel}
                onClick={toggleSelectAll}
              />
              {selectedCount > 0
                ? <span className="tasks-selection-count">{selectedCount} selected</span>
                : <span className="tasks-list-head-label">Select all</span>}
            </div>
          )}
          <div className="tasks-list" onKeyDown={handleListKeyDown}>
            {filtered.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                bulkEnabled={bulkEnabled}
                selected={selectedIds.has(t.id)}
                swimlaneId={swimlaneId}
                swimlanes={swimlanes}
                exactMatchId={exactMatchId}
                onToggleSelect={toggleSelect}
                onSelect={handleSelectTask}
              />
            ))}
          </div>
        </>
      )}

      {bulkEnabled && selectedCount > 0 && (
        <BulkActionBar
          count={selectedCount}
          archivedView={showArchived}
          columns={columns}
          swimlanes={swimlanes}
          fieldConfig={fieldConfig}
          assigneeOptions={assigneeOptions}
          pending={bulk.isPending}
          onAction={runBulk}
          onArchive={() => setConfirmKind("archive")}
          onRestore={() => setConfirmKind("restore")}
          onClear={clearSelection}
        />
      )}

      {confirmKind !== null && (
        <ConfirmDialog
          title={`${confirmVerb(confirmKind)} ${selectedCount} ${pluralTasks(selectedCount)}?`}
          confirmLabel={`${confirmVerb(confirmKind)} ${selectedCount} ${pluralTasks(selectedCount)}`}
          variant={confirmKind === "archive" ? "danger" : "default"}
          body={
            confirmKind === "archive" ? (
              <>
                <span className="font-mono text-xs">{keySummary(confirmKeys)}</span> will be archived and hidden from the live list and the header count.
                <br />
                Archived tasks can be restored later from the archived view. Activity history is kept.
              </>
            ) : (
              <>
                <span className="font-mono text-xs">{keySummary(confirmKeys)}</span> will return to their columns in the live list.
                <br />
                They rejoin the header count at their previous column positions.
              </>
            )
          }
          onCancel={() => setConfirmKind(null)}
          onConfirm={() => {
            const kind = confirmKind;
            setConfirmKind(null);
            void runBulk({ action: kind });
          }}
        />
      )}

      {(selectedTaskId !== null || isCreating) && (
        <TaskDetail
          mode={isCreating ? "create" : "view"}
          from="tasks"
          task={isCreating ? undefined : (selectedTask ?? undefined)}
          defaultSwimlaneId={defaultBacklogId}
          showCreateSwimlane
          columns={columns}
          swimlanes={swimlanes}
          columnRequiredFields={columns.map((column) => ({
            columnId: column.id,
            fields: column.requiredFields,
          }))}
          availableAssignees={[...new Set(board.tasks.flatMap((t) => t.assignees))] as string[]}
          taskTitles={new Map(board.tasks.map((t) => [t.id, t.title]))}
          taskKeys={new Map(board.tasks.map((t) => [t.id, t.key]))}
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
    </main>
  );
}

function TasksFilterBar({ filters, showArchived, columns, swimlanes, fieldConfig, assigneeOptions, onFilterChange, onShowArchivedChange, onSwimlaneChange }: {
  filters: { query: string; columnId: string; typeId: string; priorityId: string; assignee: string; swimlaneId: string; sortKey: SortKey };
  showArchived: boolean;
  columns: Column[];
  swimlanes: Swimlane[];
  fieldConfig: FieldConfig | undefined;
  assigneeOptions: string[];
  onFilterChange: (patch: Partial<{ query: string; columnId: string; typeId: string; priorityId: string; assignee: string; swimlaneId: string; sortKey: SortKey }>) => void;
  onShowArchivedChange: (v: boolean) => void;
  onSwimlaneChange: (v: string) => void;
}) {
  const { query, columnId, typeId, priorityId, assignee, swimlaneId, sortKey } = filters;
  return (
    <div className="tasks-filter">
      <input
        className="tasks-search"
        type="search"
        placeholder="Search tasks…"
        aria-label="Search tasks"
        value={query}
        onChange={(e) => onFilterChange({ query: e.target.value })}
      />
      <select className="tasks-select" value={columnId} onChange={(e) => onFilterChange({ columnId: e.target.value })} aria-label="Column filter">
        <option value="">All columns</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <select className="tasks-select" value={typeId} onChange={(e) => onFilterChange({ typeId: e.target.value })} aria-label="Type filter">
        <option value="">All types</option>
        {(fieldConfig?.types ?? []).map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
      <select className="tasks-select" value={priorityId} onChange={(e) => onFilterChange({ priorityId: e.target.value })} aria-label="Priority filter">
        <option value="">All priorities</option>
        {(fieldConfig?.priorities ?? []).map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
      <select className="tasks-select" value={assignee} onChange={(e) => onFilterChange({ assignee: e.target.value })} aria-label="Assignee filter">
        <option value="">All assignees</option>
        {assigneeOptions.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <select className="tasks-select" value={swimlaneId} onChange={(e) => onSwimlaneChange(e.target.value)} aria-label="Swimlane filter">
        <option value="">All swimlanes</option>
        {swimlanes.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
      <select className="tasks-select" value={sortKey} onChange={(e) => onFilterChange({ sortKey: e.target.value as SortKey })} aria-label="Sort order">
        <option value="board">Board order</option>
        <option value="priority">Priority</option>
        <option value="created">Newest created</option>
      </select>
      <button
        type="button"
        className={showArchived ? "tasks-archive-toggle on" : "tasks-archive-toggle"}
        onClick={() => onShowArchivedChange(!showArchived)}
      >
        Archived
      </button>
    </div>
  );
}

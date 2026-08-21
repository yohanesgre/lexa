import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBoard, useTask, useTasks, useMoveTask, useUpdateTask, useDeleteTask, useArchiveTask, useRestoreTask, useLinkGithubIssue, useUnlinkGithubIssue } from "../../lib/queries";
import { parseSwimlaneParam } from "../../lib/filters";
import type { TaskListItem } from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { TaskDetail } from "../TaskDetail";
import type { MoveTarget } from "../kanban/KanbanBoard";
import type { Task, TipTapDoc, FieldConfig, Column, Swimlane } from "../../../shared/types";

type SortKey = "board" | "priority" | "created";

// Ticket-key pattern: project prefix (2–6 chars) + dash + number — e.g. "EG-12".
const KEY_PATTERN = /^[A-Z0-9]{2,6}-\d+$/i;

export interface TasksPageProps {
  slug: string;
  search: { task?: string; swimlane?: string };
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
  const deleteTask = useDeleteTask(slug);
  const archiveTask = useArchiveTask(slug);
  const restoreTask = useRestoreTask(slug);
  const linkGithubIssue = useLinkGithubIssue(slug);
  const unlinkGithubIssue = useUnlinkGithubIssue(slug);

  const hasActiveFilters = query !== "" || columnId !== "" || typeId !== "" || priorityId !== "" || assignee !== "" || swimlaneId !== "";

  // Key-pattern search: the task whose key matches the query exactly.
  const exactMatchId = useMemo(() => {
    const q = query.trim();
    if (!KEY_PATTERN.test(q)) return null;
    return tasks?.find((t) => t.key.toLowerCase() === q.toLowerCase())?.id ?? null;
  }, [query, tasks]);

  const filtered = useMemo(() => {
    let list = tasks ?? [];
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
        list = [exact, ...list];
      }
    }
    return list;
  }, [tasks, fieldConfig, query, columnId, typeId, priorityId, assignee, swimlaneId, showArchived, sortKey, exactMatchId]);

  const clearFilters = () => {
    setFilters({ query: "", columnId: "", typeId: "", priorityId: "", assignee: "", swimlaneId: "", sortKey: "board" });
    navigate({ search: { swimlane: undefined }, replace: true } as never);
  };

  const selectedTaskId = search.task ?? null;
  const { data: selectedTaskFull } = useTask(slug, selectedTaskId);
  const selectedTask = selectedTaskFull ?? (selectedTaskId ? boardQuery.data?.tasks.find((t) => t.id === selectedTaskId) ?? null : null);

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
    toast.push("warning", "Create tasks from the board", "Open Board → column menu → Add task");
  };

  if (isLoading) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="tasks-page">
          <div className="tasks-header">
            <div className="skeleton" style={{ width: 140, height: 22 }} />
          </div>
          <div className="tasks-list">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="card-row">
                <div className="skeleton" style={{ width: i === 0 ? "55%" : `${40 + i * 9}%`, height: 14 }} />
              </div>
            ))}
          </div>
        </div>
      </main>
    );
  }
  if (error) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="tasks-error">
          <div className="tasks-error-title">Failed to load tasks</div>
          <div className="tasks-error-sub">{(error as Error).message}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!board || !tasks) return <main className="page-frame page-frame-narrow"><div className="tasks-error">Project not found</div></main>;

  const emptyProject = board.tasks.length === 0;

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
          <div className="tasks-empty-sub">Create tasks from the board.</div>
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
        <div className="tasks-list">
          {filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.archivedAt ? "card-row archived" : "card-row"}
              style={t.priorityColor !== "" ? { borderLeft: `3px solid ${t.priorityColor}` } : undefined}
              onClick={() => handleSelectTask(t)}
            >
              <span className="task-key">{t.key}</span>
              <span className="task-row-title">{t.title}</span>
                <span className="task-row-meta">
                  {swimlaneId && (
                    <span className="task-row-where">
                      <span className="task-chip gh">
                        Sprint: {swimlanes.find((l) => l.id === swimlaneId)?.name ?? swimlaneId}
                      </span>
                    </span>
                  )}
                <span className="task-row-where">
                  {t.columnColor ? (
                    <span
                      className="task-row-where-chip"
                      style={{ color: t.columnColor, background: `${t.columnColor}1a` }}
                    >
                      <span className="dot" style={{ background: t.columnColor }} />
                      {t.columnName}
                    </span>
                  ) : (
                    <span className="task-row-where-chip">{t.columnName}</span>
                  )}
                  <span>{t.swimlaneName}</span>
                </span>
                <span className="task-row-status">
                  {t.id === exactMatchId && (
                    <span className="task-chip gh">
                      exact match
                    </span>
                  )}
                  <span className="task-chip type" style={t.typeColor ? { color: t.typeColor, borderColor: t.typeColor } : undefined}>
                    {t.typeLabel}
                  </span>
                  <span className="task-chip priority" style={t.priorityColor ? { color: t.priorityColor, borderColor: t.priorityColor } : undefined}>
                    {t.priorityLabel}
                  </span>
                  {t.githubNumber !== null && <span className="task-gh">#{t.githubNumber}</span>}
                  <span className="task-row-date">{t.createdAt.slice(0, 10)}</span>
                </span>
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

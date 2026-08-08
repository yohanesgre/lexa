import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useBoard, useTasks, useMoveTask, useUpdateTask, useDeleteTask, useArchiveTask, useRestoreTask, useLinkGithubIssue, useUnlinkGithubIssue } from "../../lib/queries";
import type { TaskListItem } from "../../lib/queries";
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
  const [assignee, setAssignee] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("board");

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

  const hasActiveFilters = query !== "" || columnId !== "" || typeId !== "" || priorityId !== "" || assignee !== "";

  const filtered = useMemo(() => {
    let list = tasks ?? [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q));
    if (columnId) list = list.filter((t) => t.columnId === columnId);
    if (typeId) list = list.filter((t) => t.typeId === typeId);
    if (priorityId) list = list.filter((t) => t.priorityId === priorityId);
    if (assignee) list = list.filter((t) => t.assignees.includes(assignee));
    if (showArchived) list = list.filter((t) => t.archivedAt !== null);
    const priorityPos = new Map((fieldConfig?.priorities ?? []).map((o) => [o.id, o.position]));
    if (sortKey === "priority") {
      list = [...list].sort((a, b) => (priorityPos.get(a.priorityId) ?? 999) - (priorityPos.get(b.priorityId) ?? 999));
    } else if (sortKey === "created") {
      list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [tasks, fieldConfig, query, columnId, typeId, priorityId, assignee, showArchived, sortKey]);

  const clearFilters = () => {
    setQuery("");
    setColumnId("");
    setTypeId("");
    setPriorityId("");
    setAssignee("");
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
    toast.push("warning", "Create tasks from the board", "Open Board → column menu → Add task");
  };

  if (isLoading) {
    return (
      <main className="page-frame">
        <div className="tasks-page">
          <div className="tasks-header">
            <div className="skeleton" style={{ width: 140, height: 22 }} />
          </div>
          <div className="tasks-list">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="task-row">
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
      <main className="page-frame">
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
  if (!board || !tasks) return <main className="page-frame"><div className="tasks-error">Project not found</div></main>;

  const emptyProject = board.tasks.length === 0;

  return (
    <main className="page-frame">
      <div className="tasks-page">
        <div className="tasks-header">
          <div>
            <h1 className="tasks-title">Tasks</h1>
            <div className="tasks-sub">
              {board.project.name} · {board.tasks.filter((t) => t.archivedAt === null).length} total
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
        <select className="tasks-select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">All assignees</option>
          {assigneeOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
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
              className={t.archivedAt ? "task-row archived" : "task-row"}
              onClick={() => handleSelectTask(t)}
            >
              {t.priorityColor !== "" && <span className="task-row-accent" style={{ background: t.priorityColor }} />}
              <span className="task-row-title">{t.title}</span>
              <span className="task-row-meta">
                <span className="task-row-where">
                  {t.columnName} · {t.swimlaneName}
                </span>
                <span className="task-row-status">
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

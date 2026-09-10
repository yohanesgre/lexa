import { useNavigate } from "@tanstack/react-router";
import type { Task, TipTapDoc } from "../../../shared/types";
import { useBoard, useTask, useMoveTask, useUpdateTask, useDeleteTask, useArchiveTask, useRestoreTask, useLinkGithubIssue, useUnlinkGithubIssue } from "../../lib/queries";
import { TaskDetail } from "../TaskDetail";
import { TaskPageBar } from "../TaskPageBar";
import type { MoveTarget } from "../kanban/KanbanBoard";

interface TaskDetailPageProps {
  slug: string;
  taskId: string;
  from: "board" | "tasks" | undefined;
}

export function TaskDetailPageSkeleton() {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="task-page">
        <div className="task-page-bar">
          <div className="skeleton" style={{ width: 140, height: 14 }} />
          <div className="skeleton" style={{ width: 32, height: 32 }} />
        </div>
        <div className="skeleton" style={{ width: "55%", height: 28, marginTop: 4 }} />
        <div className="skeleton" style={{ width: "100%", height: 44, marginTop: 16 }} />
        <div className="skeleton" style={{ width: "100%", height: 260, marginTop: 16 }} />
      </div>
    </main>
  );
}

function TaskDetailNotFound({ slug, project, onBack, onBackToTasks }: { slug: string; project: { name: string } | null; onBack: () => void; onBackToTasks: () => void }) {
  return (
    <main className="page-frame page-frame-narrow">
      <div className="task-page">
        <TaskPageBar slug={slug} project={project} onBack={onBack} />
        <div
          className="empty-state"
          style={{ border: "1px solid var(--lx-border-subtle)", borderRadius: 8, background: "var(--lx-surface-card)", minHeight: 360 }}
        >
          <div className="empty-state-icon">
            <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <div className="empty-state-title">Task not found</div>
          <div className="empty-state-desc">This task was deleted or the link is stale.</div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={onBackToTasks}>
            Back to Tasks
          </button>
        </div>
      </div>
    </main>
  );
}

function taskErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export function TaskDetailPage({ slug, taskId, from }: TaskDetailPageProps) {
  const navigate = useNavigate();
  const boardQuery = useBoard(slug, false);
  const taskQuery = useTask(slug, taskId);
  // Mutations write authoritative responses under the task UUID key; a
  // KEY-addressed URL (/tasks/EG-18) must observe that key too or edits
  // never reach the rendered task.
  const canonicalId = taskQuery.data?.id ?? null;
  const canonicalQuery = useTask(slug, canonicalId);
  const task = canonicalQuery.data ?? taskQuery.data;
  const board = boardQuery.data;

  const moveTask = useMoveTask(slug);
  const updateTask = useUpdateTask(slug);
  const deleteTask = useDeleteTask(slug);
  const archiveTask = useArchiveTask(slug);
  const restoreTask = useRestoreTask(slug);
  const linkGithubIssue = useLinkGithubIssue(slug);
  const unlinkGithubIssue = useUnlinkGithubIssue(slug);

  const toTasks = () => navigate({ to: "/$slug/tasks", params: { slug } });
  const backToOrigin = () => {
    if (!from) {
      toTasks();
      return;
    }
    if (from === "board") {
      navigate({ to: "/$slug/board", params: { slug }, search: task ? { task: task.id } : {} });
    } else {
      navigate({ to: "/$slug/tasks", params: { slug }, search: task ? { task: task.id } : {} });
    }
  };
  const leaveAfterMutation = () => {
    if (from === "board") navigate({ to: "/$slug/board", params: { slug } });
    else toTasks();
  };

  const handleMove = async (id: string, target: MoveTarget) => {
    await moveTask.mutateAsync({ id, ...target });
  };
  const handleUpdate = (id: string, data: Partial<Task>) => {
    updateTask.mutate({ id, ...data });
  };
  const handleDelete = async (id: string) => {
    try {
      await deleteTask.mutateAsync({ id });
      leaveAfterMutation();
    } catch {
      // error toast comes from the mutation
    }
  };
  const handleArchive = async (id: string) => {
    try {
      await archiveTask.mutateAsync({ id });
      leaveAfterMutation();
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
    const { data: linked } = await linkGithubIssue.mutateAsync({ id, repo });
    const issue = linked.githubs.find((g) => g.repo === repo);
    return issue ? { repo: issue.repo, issueNumber: issue.issueNumber } : null;
  };
  const handleUnlinkGithub = async (id: string, issueId: string) => {
    await unlinkGithubIssue.mutateAsync({ id, issueId });
  };
  const handleCreate = async (_input: {
    title: string;
    columnId: string;
    priority: string;
    type: string;
    assignees: string[];
    description: TipTapDoc;
  }): Promise<void> => {};

  const taskError = taskQuery.error;
  const taskNotFound = task === undefined && taskError !== null
    && (taskErrorCode(taskError) === "TASK_NOT_FOUND" || taskErrorCode(taskError) === "NOT_FOUND");

  if (boardQuery.isLoading || taskQuery.isLoading) {
    return <TaskDetailPageSkeleton />;
  }
  if (boardQuery.error) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="tasks-error">
          <div className="tasks-error-title">Failed to load task</div>
          <div className="tasks-error-sub">{(boardQuery.error as Error).message}</div>
        </div>
      </main>
    );
  }
  if (taskError !== null && !taskNotFound) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="tasks-error">
          <div className="tasks-error-title">Failed to load task</div>
          <div className="tasks-error-sub">{(taskError as Error).message}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void taskQuery.refetch()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!board || !task) {
    return <TaskDetailNotFound slug={slug} project={board?.project ?? null} onBack={leaveAfterMutation} onBackToTasks={toTasks} />;
  }

  return (
    <main className="page-frame page-frame-narrow">
      <TaskDetail
        mode="view"
        variant="page"
        from={from}
        task={task}
        project={board.project}
        columns={board.columns}
        swimlanes={board.swimlanes}
        columnRequiredFields={board.columns.map((column) => ({
          columnId: column.id,
          fields: column.requiredFields,
        }))}
        availableAssignees={[...new Set(board.tasks.flatMap((t) => t.assignees))] as string[]}
        taskTitles={new Map(board.tasks.map((t) => [t.id, t.title]))}
        taskKeys={new Map(board.tasks.map((t) => [t.id, t.key]))}
        fieldConfig={board.fieldConfig}
        onClose={backToOrigin}
        onUpdate={handleUpdate}
        onMove={handleMove}
        onDelete={handleDelete}
        onArchive={handleArchive}
        onRestore={handleRestore}
        onLinkGithub={handleLinkGithub}
        onUnlinkGithub={handleUnlinkGithub}
        onCreate={handleCreate}
      />
    </main>
  );
}

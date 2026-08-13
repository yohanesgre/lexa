import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useBoard, useTask, useMoveTask, useUpdateTask, useCreateTask, useDeleteTask, useArchiveTask, useRestoreTask, useLinkGithubIssue, useUnlinkGithubIssue } from "../../lib/queries";
import { useToast } from "../../components/ui/Toast";
import { KanbanBoard } from "../../components/kanban/KanbanBoard";
import type { MoveTarget } from "../../components/kanban/KanbanBoard";
import { TaskDetail } from "../../components/TaskDetail";
import type { Task, TipTapDoc } from "../../../shared/types";

export const Route = createFileRoute("/$slug/board")({
  validateSearch: (search: Record<string, unknown>): { task?: string; swimlane?: string; milestone?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
    swimlane: typeof search.swimlane === "string" ? search.swimlane : undefined,
    milestone: typeof search.milestone === "string" ? search.milestone : undefined,
  }),
  component: BoardPage,
});

function BoardPage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const { data: board, isLoading, error } = useBoard(slug, showArchived);
  const toast = useToast();
  const moveTask = useMoveTask(slug);
  const updateTask = useUpdateTask(slug);
  const createTask = useCreateTask(slug);
  const deleteTask = useDeleteTask(slug);
  const archiveTask = useArchiveTask(slug);
  const restoreTask = useRestoreTask(slug);
  const linkGithubIssue = useLinkGithubIssue(slug);
  const unlinkGithubIssue = useUnlinkGithubIssue(slug);

  const [createTarget, setCreateTarget] = useState<{ columnId: string; swimlaneId: string } | null>(null);

  // Milestone selection: ?milestone= param wins; default = first non-archived
  // milestone (the board's active focus). Passed down to the KanbanBoard.
  const milestoneParam = search.milestone ?? null;
  const defaultMilestone = (board?.milestones ?? []).find((m) => !m.archivedAt)?.id ?? null;
  const effectiveMilestone = milestoneParam ?? defaultMilestone;

  const handleMilestoneChange = (id: string | null) => {
    navigate({ search: { milestone: id ?? undefined }, replace: true } as never);
  };

  const selectedTaskId = search.task ?? null;
  const { data: selectedTaskFull } = useTask(slug, selectedTaskId);
  const selectedTask = selectedTaskFull ?? (selectedTaskId ? board?.tasks.find((t) => t.id === selectedTaskId) ?? null : null);
  const isCreating = createTarget !== null;

  const handleMove = async (taskId: string, target: MoveTarget) => {
    await moveTask.mutateAsync({ id: taskId, ...target });
  };

  const handleOpenCreateTask = (columnId: string, swimlaneId?: string) => {
    if (!swimlaneId) return;
    setCreateTarget({ columnId, swimlaneId });
  };

  const handleCreate = async (input: {
    title: string;
    columnId: string;
    priority: string;
    type: string;
    assignees: string[];
    description: TipTapDoc;
  }) => {
    if (!createTarget) return;
    try {
      await createTask.mutateAsync({
        ...input,
        swimlaneId: createTarget.swimlaneId,
      });
      setCreateTarget(null);
    } catch (e) {
      toast.push("error", "Failed to create task", (e as Error).message);
    }
  };

  const handleUpdate = (id: string, data: Partial<Task>) => {
    updateTask.mutate({ id, ...data });
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTask.mutateAsync({ id });
      navigate({ search: { task: undefined }, replace: true } as never);
      setCreateTarget(null);
    } catch {
      // error toast comes from the mutation
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await archiveTask.mutateAsync({ id });
      navigate({ search: { task: undefined }, replace: true } as never);
      setCreateTarget(null);
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

  const handleSelectTask = (task: Task) => {
    navigate({ search: { task: task.id }, replace: true } as never);
  };

  const handleClose = () => {
    navigate({ search: { task: undefined }, replace: true } as never);
    setCreateTarget(null);
  };

  if (isLoading) {
    return (
      <div className="board-area">
        <div className="board-header">
          <div className="skeleton" style={{ width: 140, height: 22 }} />
          <div className="flex items-center gap-2">
            <div className="skeleton" style={{ width: 72, height: 32 }} />
            <div className="skeleton" style={{ width: 88, height: 32 }} />
          </div>
        </div>
        <div className="board-scroll" style={{ overflow: "hidden" }}>
          {[0, 1, 2].map((lane) => (
            <div key={lane}>
              <div className="skeleton" style={{ width: 320, height: 36, marginBottom: 12 }} />
              <div className="columns-row">
                {[0, 1, 2, 3].map((col) => (
                  <div key={col} className="column" style={{ minHeight: 320 }}>
                    <div className="column-header">
                      <div className="skeleton" style={{ width: col * 23 + 52, height: 12 }} />
                    </div>
                    <div className="column-body">
                      {[0, 1].map((card) => (
                        <div key={card} className="bg-lx-surface-card border border-lx-border-subtle rounded-md" style={{ padding: "10px 12px" }}>
                          <div className="skeleton" style={{ width: card === 0 ? 56 : 40, height: 18 }} />
                          <div className="skeleton mt-2" style={{ width: card === 0 ? "85%" : "92%", height: 14 }} />
                          <div className="skeleton mt-1" style={{ width: card === 0 ? "60%" : "45%", height: 14 }} />
                          <div className="flex items-center gap-2 mt-2">
                            <div className="skeleton skeleton-circle" style={{ width: 20, height: 20 }} />
                            <div className="skeleton" style={{ width: card === 0 ? 72 : 56, height: 12 }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (error) return <div className="board-error">Failed to load board: {(error as Error).message}</div>;
  if (!board) return <div className="board-error">Project not found</div>;

  return (
    <div className="board-page">
      <KanbanBoard
        board={board}
        showArchived={showArchived}
        onToggleArchived={setShowArchived}
        onMoveTask={handleMove}
        onSelectTask={handleSelectTask}
        onOpenCreateTask={handleOpenCreateTask}
        milestoneId={effectiveMilestone}
        onMilestoneChange={handleMilestoneChange}
      />
      {(selectedTaskId !== null || isCreating) && (
        <TaskDetail
          mode={isCreating ? "create" : "view"}
          task={selectedTask ?? undefined}
          defaultColumnId={createTarget?.columnId}
          columns={board.columns}
          swimlanes={board.swimlanes}
          columnRequiredFields={board.columns.map((column) => ({
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

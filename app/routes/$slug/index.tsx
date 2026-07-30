import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useBoard, useMoveTask, useUpdateTask, useCreateTask, useDeleteTask } from "../../lib/queries";
import { KanbanBoard } from "../../components/kanban/KanbanBoard";
import type { MoveTarget } from "../../components/kanban/KanbanBoard";
import { TaskDetail } from "../../components/TaskDetail";
import type { Priority, Task, TaskType, TipTapDoc } from "../../../shared/types";

export const Route = createFileRoute("/$slug/")({
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
  }),
  component: BoardPage,
});

function BoardPage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: board, isLoading, error } = useBoard(slug);
  const moveTask = useMoveTask(slug);
  const updateTask = useUpdateTask(slug);
  const createTask = useCreateTask(slug);
  const deleteTask = useDeleteTask(slug);

  const [createTarget, setCreateTarget] = useState<{ columnId: string; swimlaneId: string } | null>(null);

  const selectedTaskId = search.task ?? null;
  const selectedTask = selectedTaskId ? board?.tasks.find((t) => t.id === selectedTaskId) ?? null : null;
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
    priority: Priority;
    type: TaskType;
    assignees: string[];
    description: TipTapDoc;
  }) => {
    try {
      await createTask.mutateAsync({
        ...input,
        swimlaneId: createTarget.swimlaneId,
      });
      setCreateTarget(null);
    } catch (e) {
      console.error("Task create failed", e);
    }
  };

  const handleUpdate = (id: string, data: Partial<Task>) => {
    updateTask.mutate({ id, ...data });
  };

  const handleDelete = async (id: string) => {
    await deleteTask.mutateAsync({ id });
    navigate({ search: { task: undefined }, replace: true } as never);
    setCreateTarget(null);
  };

  const handleSelectTask = (task: Task) => {
    navigate({ search: { task: task.id }, replace: true } as never);
  };

  const handleClose = () => {
    navigate({ search: { task: undefined }, replace: true } as never);
    setCreateTarget(null);
  };

  if (isLoading) return <div className="board-loading">Loading board…</div>;
  if (error) return <div className="board-error">Failed to load board: {(error as Error).message}</div>;
  if (!board) return <div className="board-error">Project not found</div>;

  return (
    <div className="board-page">
      <KanbanBoard
        board={board}
        onMoveTask={handleMove}
        onSelectTask={handleSelectTask}
        onOpenCreateTask={handleOpenCreateTask}
      />
      {(selectedTask || isCreating) && (
        <TaskDetail
          mode={isCreating ? "create" : "view"}
          task={selectedTask ?? undefined}
          defaultColumnId={createTarget?.columnId}
          columns={board.columns}
          columnRequiredFields={board.columns.map((column) => ({
            columnId: column.id,
            fields: column.requiredFields,
          }))}
          availableAssignees={[...new Set(board.tasks.flatMap((t) => t.assignees))] as string[]}
          onClose={handleClose}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useBoard, useMoveTask, useUpdateTask, useCreateTask } from "../../lib/queries";
import { KanbanBoard } from "../../components/kanban/KanbanBoard";
import type { MoveTarget } from "../../components/kanban/KanbanBoard";
import { TaskDetail } from "../../components/TaskDetail";
import type { Task } from "../../../shared/types";

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

  const selectedTaskId = search.task ?? null;
  const selectedTask = selectedTaskId ? board?.tasks.find((t) => t.id === selectedTaskId) ?? null : null;

  const handleMove = async (taskId: string, target: MoveTarget) => {
    await moveTask.mutateAsync({ id: taskId, ...target });
  };

  const handleCreateTask = async (input: { columnId: string; swimlaneId?: string | null; title: string }) => {
    await createTask.mutateAsync({ ...input, swimlaneId: input.swimlaneId ?? null });
  };

  const handleUpdate = (id: string, data: Partial<Task>) => {
    updateTask.mutate({ id, ...data }, {
      onError: (e) => console.error("Task update failed", e),
    });
  };

  const handleSelectTask = (task: Task) => {
    navigate({ search: { task: task.id }, replace: true } as never);
  };

  const handleClose = () => {
    navigate({ search: { task: undefined }, replace: true } as never);
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
        onCreateTask={handleCreateTask}
      />
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={handleClose}
          onUpdate={handleUpdate}
          columnName={board.columns.find((c) => c.id === selectedTask.columnId)?.name}
        />
      )}
    </div>
  );
}

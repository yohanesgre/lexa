import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useBoard, useMoveTask, useUpdateTask } from "../../lib/queries";
import { KanbanBoard } from "../../components/kanban/KanbanBoard";
import type { MoveTarget } from "../../components/kanban/KanbanBoard";
import { TaskDetail } from "../../components/TaskDetail";
import type { Task } from "../../../shared/types";

export const Route = createFileRoute("/$slug/")({
  component: BoardPage,
});

function BoardPage() {
  const { slug } = Route.useParams();
  const { data: board, isLoading, error } = useBoard(slug);
  const moveTask = useMoveTask(slug);
  const updateTask = useUpdateTask(slug);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const handleMove = async (taskId: string, target: MoveTarget) => {
    await moveTask.mutateAsync({ id: taskId, ...target });
  };

  const handleUpdate = (id: string, data: Partial<Task>) => {
    const input: Record<string, unknown> = { id };
    if (data.title !== undefined) input.title = data.title;
    if (data.description !== undefined) input.description = JSON.stringify(data.description);
    if (data.priority !== undefined) input.priority = data.priority;
    if (data.type !== undefined) input.type = data.type;
    if (data.assignee !== undefined) input.assignee = data.assignee;
    updateTask.mutate(input as Parameters<typeof updateTask.mutate>[0], {
      onError: (e) => console.error("Task update failed", e),
    });
  };

  if (isLoading) return <div className="board-loading">Loading board…</div>;
  if (error) return <div className="board-error">Failed to load board: {(error as Error).message}</div>;
  if (!board) return <div className="board-error">Project not found</div>;

  return (
    <div className="board-page">
      <KanbanBoard
        board={board}
        onMoveTask={handleMove}
        onSelectTask={(task) => setSelectedTask(task)}
      />
      {selectedTask && (
        <div className="task-detail-overlay" onClick={() => setSelectedTask(null)}>
          <div className="task-detail-wrapper" onClick={(e) => e.stopPropagation()}>
            <TaskDetail
              task={selectedTask}
              onClose={() => setSelectedTask(null)}
              onUpdate={handleUpdate}
              columnName={board.columns.find((c) => c.id === selectedTask.columnId)?.name}
            />
          </div>
        </div>
      )}
    </div>
  );
}

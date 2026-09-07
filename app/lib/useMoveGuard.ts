import { useState } from "react";
import type { Task, Board } from "../../shared/types";
import type { MoveTarget } from "../components/kanban/KanbanBoard";
import { useMoveTask } from "./queries";
import { formatDueLabel } from "./dates";

export function useMoveGuard(slug: string, board: Board | undefined) {
  const moveTask = useMoveTask(slug);
  const [pending, setPending] = useState<{ task: Task; target: MoveTarget } | null>(null);
  // Returns the in-flight mutation promise (the board awaits it to revert its
  // optimistic state on rejection), or false when the confirm dialog takes
  // over — the dialog path commits without optimistic local state.
  const confirmMove = (task: Task, target: MoveTarget): Promise<unknown> | false => {
    const lane = board?.swimlanes.find((l) => l.id === target.swimlaneId);
    const laneOverdue = !!lane?.dueAt && formatDueLabel(lane.dueAt).overdue;
    const conflict = !!task.dueAt && !!lane?.dueAt && task.dueAt > lane.dueAt;
    if (!laneOverdue && !conflict) {
      return moveTask.mutateAsync({ id: task.id, ...target });
    }
    setPending({ task, target });
    return false;
  };
  const resolve = (clearDueAt: boolean) => {
    if (!pending) return;
    void moveTask.mutateAsync({ id: pending.task.id, ...pending.target, ...(clearDueAt ? { clearDueAt: true } : {}) });
    setPending(null);
  };
  return { confirmMove, pending, resolve, cancel: () => setPending(null) };
}

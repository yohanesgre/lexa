import { useState } from "react";
import type { BoardTask, Board } from "../../shared/types";
import type { MoveTarget } from "../components/kanban/KanbanBoard";
import { useMoveTask } from "./queries";
import { formatDueLabel } from "./dates";

export function useMoveGuard(slug: string, board: Board | undefined) {
  const moveTask = useMoveTask(slug);
  const [pending, setPending] = useState<{ task: BoardTask; target: MoveTarget } | null>(null);
  // Returns the in-flight mutation promise (the board awaits it to revert its
  // optimistic state on rejection), or false when the confirm dialog takes
  // over — the dialog path commits without optimistic local state.
  const confirmMove = (task: BoardTask, target: MoveTarget): Promise<unknown> | false => {
    const lane = board?.swimlanes.find((l) => l.id === target.swimlaneId);
    const laneOverdue = !!lane?.dueAt && formatDueLabel(lane.dueAt).overdue;
    const conflict = !!task.dueAt && !!lane?.dueAt && task.dueAt > lane.dueAt;
    if (!laneOverdue && !conflict) {
      return moveTask.mutateAsync({ id: task.id, ...target });
    }
    setPending({ task, target });
    return false;
  };
  // Returns the in-flight mutation promise so the caller can route the
  // confirm-dialog move's rejection (e.g. WIP_LIMIT) through the same
  // feedback handler as the free path.
  const resolve = (clearDueAt: boolean): Promise<unknown> | undefined => {
    if (!pending) return undefined;
    const { task, target } = pending;
    setPending(null);
    return moveTask.mutateAsync({ id: task.id, ...target, ...(clearDueAt ? { clearDueAt: true } : {}) });
  };
  return { confirmMove, pending, resolve, cancel: () => setPending(null) };
}

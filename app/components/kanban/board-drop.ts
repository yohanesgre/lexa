import type { DragEndEvent } from "@dnd-kit/core";
import type { Task } from "../../../shared/types";
import { keyAfter, keyBetween } from "../../../shared/positions";
import { byPosition } from "./board-utils";

// Pure drop-resolution logic for the board — the drag end handler in
// KanbanBoard delegates here so the conversion of a drop position into a
// canonical target (column/lane/before/after) stays testable.

export interface MoveTarget {
  columnId: string;
  swimlaneId: string;
  beforeTaskId?: string | undefined;
  afterTaskId?: string | undefined;
}

export function computeDropTarget(
  task: Task,
  over: DragEndEvent["over"],
  tasksInCell: (columnId: string, laneId: string) => Task[],
  allTasks: Task[]
): MoveTarget | null {
  if (!over) return null;
  const overData = over.data.current as
    | { type?: string | undefined; columnId?: string | undefined; swimlaneId?: string }
    | undefined;

  if (overData?.type === "column") {
    const targetColumnId = overData.columnId!;
    const targetLaneId = overData.swimlaneId!;
    const anchor =
      tasksInCell(targetColumnId, targetLaneId)
        .filter((t) => t.id !== task.id)
        .at(-1) ??
      allTasks
        .filter((t) => t.columnId === targetColumnId && t.id !== task.id)
        .sort(byPosition)
        .at(-1);
    return { columnId: targetColumnId, swimlaneId: targetLaneId, beforeTaskId: anchor?.id, afterTaskId: undefined };
  }

  const overTask = allTasks.find((t) => t.id === String(over.id));
  if (!overTask) return null;
  const items = tasksInCell(overTask.columnId, overTask.swimlaneId).filter((t) => t.id !== task.id);
  const idx = items.findIndex((t) => t.id === overTask.id);
  const fromAbove =
    task.columnId !== overTask.columnId ||
    task.swimlaneId !== overTask.swimlaneId ||
    task.position < overTask.position;
  return fromAbove
    ? { columnId: overTask.columnId, swimlaneId: overTask.swimlaneId, beforeTaskId: overTask.id, afterTaskId: items[idx + 1]?.id }
    : { columnId: overTask.columnId, swimlaneId: overTask.swimlaneId, afterTaskId: overTask.id, beforeTaskId: items[idx - 1]?.id };
}

export function computeDropPosition(task: Task, target: MoveTarget, allTasks: Task[]): string {
  const anchorBefore = target.beforeTaskId ? allTasks.find((t) => t.id === target.beforeTaskId) : undefined;
  const anchorAfter = target.afterTaskId ? allTasks.find((t) => t.id === target.afterTaskId) : undefined;
  if (target.beforeTaskId || target.afterTaskId) {
    return keyBetween(anchorBefore?.position ?? null, anchorAfter?.position ?? null);
  }
  return keyAfter(
    allTasks
      .filter((t) => t.columnId === target.columnId && t.id !== task.id)
      .sort(byPosition)
      .at(-1)?.position ?? null
  );
}
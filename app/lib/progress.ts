import type { Board } from "../../shared/types";

export interface SprintProgressCount {
  done: number;
  total: number;
}

function doneColumnIdSet(columns: Board["columns"]): Set<string> {
  return columns.reduce<Set<string>>((acc, c) => {
    if (c.isDone) acc.add(c.id);
    return acc;
  }, new Set());
}

// Sprint X/Y: X = tasks in the sprint that are done (in a done column OR
// archived); Y = all tasks in the sprint, including archived. Derived from
// board data — never stored.
export function sprintProgress(board: Board, swimlaneId: string): SprintProgressCount {
  const doneColumnIds = doneColumnIdSet(board.columns);
  const tasks = board.tasks.filter((t) => t.swimlaneId === swimlaneId);
  const done = tasks.filter((t) => t.archivedAt !== null || doneColumnIds.has(t.columnId)).length;
  return { done, total: tasks.length };
}

export function isSprintReadyToArchive(progress: SprintProgressCount): boolean {
  return progress.total > 0 && progress.done === progress.total;
}

// Milestone task progress: all tasks whose sprint belongs to the milestone.
export function milestoneTaskProgress(board: Board, milestoneId: string): SprintProgressCount {
  const laneIds = board.swimlanes.reduce<Set<string>>((acc, l) => {
    if (l.milestoneId === milestoneId) acc.add(l.id);
    return acc;
  }, new Set());
  const doneColumnIds = doneColumnIdSet(board.columns);
  const tasks = board.tasks.filter((t) => laneIds.has(t.swimlaneId));
  const done = tasks.filter((t) => t.archivedAt !== null || doneColumnIds.has(t.columnId)).length;
  return { done, total: tasks.length };
}

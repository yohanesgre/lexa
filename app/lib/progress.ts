import type { Board, Task } from "../../shared/types";

export interface SprintProgressCount {
  done: number;
  total: number;
}

// Sprint X/Y: X = tasks in the sprint that are done (in a done column OR
// archived); Y = all tasks in the sprint, including archived. Derived from
// board data — never stored.
export function sprintProgress(board: Board, swimlaneId: string): SprintProgressCount {
  const doneColumnIds = new Set(board.columns.filter((c) => c.isDone).map((c) => c.id));
  const tasks = board.tasks.filter((t) => t.swimlaneId === swimlaneId);
  const done = tasks.filter((t) => t.archivedAt !== null || doneColumnIds.has(t.columnId)).length;
  return { done, total: tasks.length };
}

export function isSprintReadyToArchive(progress: SprintProgressCount): boolean {
  return progress.total > 0 && progress.done === progress.total;
}

// Milestone task progress: all tasks whose sprint belongs to the milestone.
export function milestoneTaskProgress(board: Board, milestoneId: string): SprintProgressCount {
  const laneIds = new Set(board.swimlanes.filter((l) => l.milestoneId === milestoneId).map((l) => l.id));
  const doneColumnIds = new Set(board.columns.filter((c) => c.isDone).map((c) => c.id));
  const tasks = board.tasks.filter((t) => laneIds.has(t.swimlaneId));
  const done = tasks.filter((t) => t.archivedAt !== null || doneColumnIds.has(t.columnId)).length;
  return { done, total: tasks.length };
}

export function tasksInSprint(board: Board, swimlaneId: string): Task[] {
  return board.tasks.filter((t) => t.swimlaneId === swimlaneId);
}

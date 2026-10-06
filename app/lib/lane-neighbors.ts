import type { BoardTask } from "../../shared/types";

export interface LaneNeighbors {
  beforeTaskId?: string;
  afterTaskId?: string;
}

// A lane-only move must not reposition the task. The move endpoint computes a
// new position from the supplied neighbors, so pass the task's current
// same-column neighbors to keep its relative order (the server appends to the
// end when they are absent).
export function laneNeighbors(tasks: BoardTask[], task: BoardTask): LaneNeighbors {
  let before: BoardTask | undefined;
  let after: BoardTask | undefined;
  for (const candidate of tasks) {
    if (candidate.id === task.id || candidate.columnId !== task.columnId) continue;
    if (candidate.position < task.position) {
      if (!before || candidate.position > before.position) before = candidate;
    } else if (candidate.position > task.position) {
      if (!after || candidate.position < after.position) after = candidate;
    }
  }
  return {
    ...(before ? { beforeTaskId: before.id } : {}),
    ...(after ? { afterTaskId: after.id } : {}),
  };
}

import { useMemo } from "react";
import type { Board, Task } from "../../../shared/types";

// Shared pure helpers/reducers for the board surface — no components here.

export const byPosition = (a: Task, b: Task) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

export const cellDropId = (columnId: string, laneId: string | null) => `cell:${laneId ?? "none"}:${columnId}`;

export function cardProps(task: Task, board: Board) {
  return {
    id: task.id,
    taskKey: task.key,
    title: task.title,
    priority: task.priority,
    type: task.type,
    priorities: board.fieldConfig?.priorities ?? [],
    types: board.fieldConfig?.types ?? [],
    assignees: task.assignees,
    githubs: task.githubs,
    dueAt: task.dueAt,
  };
}

export function tasksReducer(state: Task[], action: { type: "set"; tasks: Task[] } | { type: "move"; taskId: string; columnId: string; swimlaneId: string; position: string }): Task[] {
  if (action.type === "set") return action.tasks;
  return state.map((t) => (t.id === action.taskId ? { ...t, columnId: action.columnId, swimlaneId: action.swimlaneId, position: action.position } : t));
}

// Link maps derived from board.links: children per parent, blocked-by titles per task.
export function useLinkMaps(board: Board) {
  return useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    const parentOf = new Map<string, string>();
    const blockedBy = new Map<string, string[]>();
    const titleById = new Map(board.tasks.map((t) => [t.id, t.title]));
    for (const link of board.links) {
      if (link.relation === "subtask_of") {
        const kids = childrenByParent.get(link.toTaskId) ?? [];
        kids.push(link.fromTaskId);
        childrenByParent.set(link.toTaskId, kids);
        parentOf.set(link.fromTaskId, link.toTaskId);
      } else if (link.relation === "blocked_by") {
        const blockers = blockedBy.get(link.fromTaskId) ?? [];
        const title = titleById.get(link.toTaskId);
        if (title) blockers.push(title);
        blockedBy.set(link.fromTaskId, blockers);
      }
    }
    return { childrenByParent, blockedBy };
  }, [board.links, board.tasks]);
}
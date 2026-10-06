import { memo, useCallback, useMemo } from "react";
import type { Board, Swimlane, Task } from "../../../shared/types";
import { Column } from "./Column";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "../ui/cn";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { ColumnHeader } from "./ColumnHeader";
import { SortableTaskCard } from "./SortableTaskCard";
import { byPosition } from "./board-utils";

export interface BoardLaneProps {
  slug: string;
  lane: Swimlane;
  columns: Array<import("../../../shared/types").Column>;
  board: Board;
  localTasks: Task[];
  cellMap: Map<string, Task[]>;
  childrenByParent: Map<string, string[]>;
  parentOf: Map<string, string>;
  blockedBy: Map<string, string[]>;
  cardHidden: (t: Task) => boolean;
  cardDimmed: (t: Task) => boolean;
  columnTotalCount: (columnId: string) => number;
  columnDimmed: (columnId: string) => boolean;
  cellDropId: (columnId: string, laneId: string) => string;
  flashColumnId: string | null;
  collapsed: ReadonlySet<string>;
  toggleLane: (laneId: string) => void;
  onOpenCreateTask?: ((columnId: string, laneId?: string | undefined) => void) | undefined;
  onSelectTask: (t: Task) => void;
  onDelete?: ((id: string) => void) | undefined;
  selectedTaskId: string | null;
  newTaskIds: Set<string>;
  shakeTaskId: string | null;
  archiveTask: { mutate: (input: { id: string }) => unknown };
  restoreTask: { mutate: (input: { id: string }) => unknown };
  collapsedParents: ReadonlySet<string>;
  setCollapsedParents: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
}

export const BoardLane = memo(function BoardLane({
  slug, lane, columns, board, localTasks, cellMap, childrenByParent, parentOf, blockedBy,
  cardHidden, cardDimmed, columnTotalCount, columnDimmed, cellDropId,
  flashColumnId, collapsed, toggleLane, onOpenCreateTask, onSelectTask,
  onDelete, selectedTaskId, newTaskIds, shakeTaskId, archiveTask, restoreTask,
  collapsedParents, setCollapsedParents,
}: BoardLaneProps) {
  const laneId = lane.id;
  const laneTaskCount = useMemo(
    () => localTasks.reduce((n, t) => (t.swimlaneId === laneId ? n + 1 : n), 0),
    [localTasks, laneId]
  );
  const isCollapsed = collapsed.has(laneId);
  const tasksInCell = (columnId: string, lId: string) => cellMap.get(`${columnId}:${lId}`) ?? [];
  const handleArchive = useCallback((id: string) => { archiveTask.mutate({ id }); }, [archiveTask.mutate]);
  const handleRestore = useCallback((id: string) => { restoreTask.mutate({ id }); }, [restoreTask.mutate]);
  const handleToggleSubtasks = useCallback((taskId: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [setCollapsedParents]);
  // Parent ids that actually render as a parent in each cell: same-cell,
  // visible, top-level (a card that is itself a child renders nested, so its
  // own children fall back to top-level). A child is nested only when its
  // canonical parent is in this set — otherwise an archived, filtered, or
  // off-cell parent would strand the child with no card anywhere.
  const parentIdsByCell = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of localTasks) {
      if (cardHidden(t) || parentOf.has(t.id)) continue;
      const key = `${t.columnId}:${t.swimlaneId}`;
      const s = m.get(key);
      if (s) s.add(t.id);
      else m.set(key, new Set([t.id]));
    }
    return m;
  }, [localTasks, parentOf, cardHidden]);
  const nestedUnder = (task: Task): boolean => {
    const parentId = parentOf.get(task.id);
    return !!parentId && parentIdsByCell.get(`${task.columnId}:${task.swimlaneId}`)?.has(parentId) === true;
  };
  // Rendered children of a parent card, in position order, hidden/off-cell
  // ones dropped. Only the canonical parent renders a shared child, so a task
  // linked to two subtask_of parents renders once.
  const visibleKidsFor = (task: Task) =>
    (childrenByParent.get(task.id) ?? [])
      .map((id) => localTasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t)
      .filter((t) => !cardHidden(t))
      .filter((t) => t.columnId === task.columnId && t.swimlaneId === task.swimlaneId)
      .filter((t) => parentOf.get(t.id) === task.id)
      .sort(byPosition);
  return (
    <div key={laneId}>
      <SwimlaneHeader
        slug={slug}
        lane={lane}
        count={laneTaskCount}
        collapsed={isCollapsed}
        onToggle={() => toggleLane(lane.id)}
        board={board}
      />
      {!isCollapsed && (
        <div className="columns-row">
          {columns.map((col) => {
            const cell = tasksInCell(col.id, laneId);
            const dimmed = columnDimmed(col.id);
            return (
              <div className={cn("column", dimmed && "opacity-45")} key={col.id}>
                <ColumnHeader
                  slug={slug}
                  column={col}
                  taskCount={columnTotalCount(col.id)}
                  wipLimit={col.wipLimit}
                  wipFlash={flashColumnId === col.id}
                  dimmed={dimmed}
                  onOpenCreate={() => onOpenCreateTask?.(col.id, laneId)}
                />
                <Column
                  id={cellDropId(col.id, laneId)}
                  data={{ type: "column", columnId: col.id, swimlaneId: laneId }}
                  isEmpty={cell.length === 0}
                  slug={slug}
                  columnId={col.id}
                  swimlaneId={laneId}
                  priorities={board.fieldConfig?.priorities ?? []}
                  types={board.fieldConfig?.types ?? []}
                  onOpenCreate={() => onOpenCreateTask?.(col.id, laneId)}
                >
                  <SortableContext
                    items={cell.flatMap((t) =>
                      cardHidden(t) || nestedUnder(t)
                        ? []
                        : [t.id, ...(collapsedParents.has(t.id) ? [] : visibleKidsFor(t).map((k) => k.id))]
                    )}
                    strategy={verticalListSortingStrategy}
                  >
                    {cell.flatMap((task) => {
                      if (cardHidden(task) || nestedUnder(task)) return []; // nested subtasks render under their parent
                      const kids = visibleKidsFor(task);
                      const isCollapsed = collapsedParents.has(task.id);
                      const card = (
                        <div key={task.id}>
                          <SortableTaskCard
                            task={task}
                            board={board}
                            onSelect={onSelectTask}
                            dimmed={cardDimmed(task)}
                            isNew={newTaskIds.has(task.id)}
                            isShaking={shakeTaskId === task.id}
                            onArchive={handleArchive}
                            onRestore={handleRestore}
                            onDelete={onDelete}
                            selected={task.id === selectedTaskId}
                            blockedBy={blockedBy.get(task.id) ?? []}
                            subtaskCount={kids.length}
                            onToggleSubtasks={() => handleToggleSubtasks(task.id)}
                            subtasksCollapsed={isCollapsed}
                          />
                          {!isCollapsed &&
                            kids.map((kid) => (
                              <SortableTaskCard
                                key={kid.id}
                                task={kid}
                                board={board}
                                onSelect={onSelectTask}
                                dimmed={cardDimmed(kid)}
                                isNew={newTaskIds.has(kid.id)}
                                isShaking={shakeTaskId === kid.id}
                                onArchive={handleArchive}
                                onRestore={handleRestore}
                                onDelete={onDelete}
                                selected={kid.id === selectedTaskId}
                                isSubtask
                                blockedBy={blockedBy.get(kid.id) ?? []}
                              />
                            ))}
                        </div>
                      );
                      return [card];
                    })}
                  </SortableContext>
                </Column>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

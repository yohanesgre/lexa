import type { Swimlane, Task } from "../../../shared/types";
import { Column } from "./Column";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "../ui/cn";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { ColumnHeader } from "./ColumnHeader";
import { SortableTaskCard } from "./SortableTaskCard";
const byPosition = (a: Task, b: Task) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

export interface BoardLaneProps {
  slug: string;
  lane: Swimlane;
  columns: Array<import("../../../shared/types").Column>;
  board: any;
  localTasks: Task[];
  childrenByParent: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
  cardHidden: (t: Task) => boolean;
  cardDimmed: (t: Task) => boolean;
  columnTotalCount: (columnId: string) => number;
  columnDimmed: (columnId: string) => boolean;
  cellDropId: (columnId: string, laneId: string) => string;
  flashColumnId: string | null;
  collapsed: ReadonlySet<string>;
  toggleLane: (laneId: string) => void;
  onOpenCreateTask?: (columnId: string, laneId: string) => void;
  onSelectTask: (t: Task) => void;
  newTaskIds: Set<string>;
  shakeTaskId: string | null;
  archiveTask: { mutate: (input: { id: string }) => unknown };
  restoreTask: { mutate: (input: { id: string }) => unknown };
  collapsedParents: ReadonlySet<string>;
  setCollapsedParents: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
}

export function BoardLane({
  slug, lane, columns, board, localTasks, childrenByParent, blockedBy,
  cardHidden, cardDimmed, columnTotalCount, columnDimmed, cellDropId,
  flashColumnId, collapsed, toggleLane, onOpenCreateTask, onSelectTask,
  newTaskIds, shakeTaskId, archiveTask, restoreTask, collapsedParents, setCollapsedParents,
}: BoardLaneProps) {
  const laneId = lane.id;
  const laneTaskCount = localTasks.filter((t) => t.swimlaneId === laneId).length;
  const isCollapsed = collapsed.has(laneId);
  const tasksInCell = (columnId: string, lId: string) =>
    localTasks.filter((t) => t.columnId === columnId && t.swimlaneId === lId);
  return (
    <div key={laneId}>
      <SwimlaneHeader
        slug={slug}
        lane={lane}
        count={laneTaskCount}
        collapsed={isCollapsed}
        onToggle={() => toggleLane(lane.id)}
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
                  <SortableContext items={cell.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    {cell.flatMap((task) => {
                      if (cardHidden(task) || childrenByParent.has(task.id)) return []; // parents render at top level
                      const kids = (childrenByParent.get(task.id) ?? [])
                        .map((id) => localTasks.find((t) => t.id === id))
                        .filter((t): t is Task => !!t)
                        .filter((t) => !cardHidden(t))
                        .sort(byPosition);
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
                            onArchive={(id) => archiveTask.mutate({ id })}
                            onRestore={(id) => restoreTask.mutate({ id })}
                            blockedBy={blockedBy.get(task.id) ?? []}
                            subtaskCount={kids.length}
                            onToggleSubtasks={() =>
                              setCollapsedParents((prev) => {
                                const next = new Set(prev);
                                if (next.has(task.id)) next.delete(task.id);
                                else next.add(task.id);
                                return next;
                              })
                            }
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
                                onArchive={(id) => archiveTask.mutate({ id })}
                                onRestore={(id) => restoreTask.mutate({ id })}
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
}

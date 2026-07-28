import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import type { Board, Swimlane, Task } from "../../../shared/types";
import { keyAfter, keyBetween } from "../../../shared/positions";
import { cn } from "../ui/cn";
import { Column } from "./Column";
import { ColumnHeader } from "./ColumnHeader";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { TaskCard } from "./TaskCard";
import { FilterButton, ActiveFilterBar, emptyFilters, isFilterActive, type FilterState } from "./BoardFilters";

export interface MoveTarget {
  columnId: string;
  swimlaneId?: string | null;
  beforeTaskId?: string;
  afterTaskId?: string;
}

interface KanbanBoardProps {
  board: Board;
  onMoveTask: (taskId: string, target: MoveTarget) => Promise<void>;
  onSelectTask?: (task: Task) => void;
  onOpenCreateTask?: (columnId: string, swimlaneId?: string | null) => void;
}

const byPosition = (a: Task, b: Task) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

const isWipLimit = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === "WIP_LIMIT" || (typeof e.message === "string" && e.message.includes("WIP_LIMIT"));
};

function cardProps(task: Task) {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    type: task.type,
    assignee: task.assignee,
    github: task.github,
    githubOutOfSync: task.github?.outOfSync ?? false,
  };
}

function SortableTaskCard({
  task,
  onSelect,
  dimmed,
}: {
  task: Task;
  onSelect?: (t: Task) => void;
  dimmed: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card", columnId: task.columnId, swimlaneId: task.swimlaneId },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "drag-source")}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (!isDragging) { e.stopPropagation(); onSelect?.(task); }
      }}
    >
      <TaskCard {...cardProps(task)} dimmed={dimmed} />
    </div>
  );
}

export function KanbanBoard({ board, onMoveTask, onSelectTask, onOpenCreateTask }: KanbanBoardProps) {
  const [localTasks, setLocalTasks] = useState<Task[]>(board.tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [flashColumnId, setFlashColumnId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<FilterState>(emptyFilters());
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    setLocalTasks(board.tasks);
  }, [board.tasks]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    []
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const columns = useMemo(() => [...board.columns].sort((a, b) => a.position - b.position), [board.columns]);
  const lanes = useMemo(() => [...board.swimlanes].sort((a, b) => a.position - b.position), [board.swimlanes]);
  const hasLanes = lanes.length > 0;

  const rows = useMemo<{ lane: Swimlane | null }[]>(() => {
    if (!hasLanes) return [{ lane: null }];
    const r: { lane: Swimlane | null }[] = lanes.map((lane) => ({ lane }));
    if (localTasks.some((t) => t.swimlaneId === null)) r.unshift({ lane: null });
    return r;
  }, [hasLanes, lanes, localTasks]);

  const tasksInCell = useCallback(
    (columnId: string, laneId: string | null) =>
      localTasks
        .filter((t) => t.columnId === columnId && (hasLanes ? (t.swimlaneId ?? null) === laneId : true))
        .sort(byPosition),
    [localTasks, hasLanes]
  );

  const columnDimmed = useCallback(
    (columnId: string) => filters.columns.size > 0 && !filters.columns.has(columnId),
    [filters.columns]
  );

  const cardDimmed = useCallback(
    (task: Task) => {
      if (filters.columns.size > 0 && !filters.columns.has(task.columnId)) return true;
      if (filters.priorities.size > 0 && !filters.priorities.has(task.priority)) return true;
      if (filters.types.size > 0 && !filters.types.has(task.type)) return true;
      if (filters.assignees.size > 0 && !filters.assignees.has(task.assignee ?? "")) return true;
      if (filters.swimlanes.size > 0 && !filters.swimlanes.has(task.swimlaneId ?? "")) return true;
      return false;
    },
    [filters]
  );

  const cellDropId = (columnId: string, laneId: string | null) => `cell:${laneId ?? "none"}:${columnId}`;

  const toggleLane = (laneId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });

  const activeTask = activeId ? localTasks.find((t) => t.id === activeId) : undefined;

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;
    const task = localTasks.find((t) => t.id === String(active.id));
    if (!task) return;
    if (String(over.id) === task.id) return;

    const overData = over.data.current as
      | { type?: string; columnId?: string; swimlaneId?: string | null }
      | undefined;

    let targetColumnId: string;
    let targetLaneId: string | null;
    let beforeTaskId: string | undefined;
    let afterTaskId: string | undefined;

    if (overData?.type === "column") {
      targetColumnId = overData.columnId!;
      targetLaneId = overData.swimlaneId ?? null;
      const anchor =
        tasksInCell(targetColumnId, targetLaneId)
          .filter((t) => t.id !== task.id)
          .at(-1) ??
        localTasks
          .filter((t) => t.columnId === targetColumnId && t.id !== task.id)
          .sort(byPosition)
          .at(-1);
      beforeTaskId = anchor?.id;
    } else {
      const overTask = localTasks.find((t) => t.id === String(over.id));
      if (!overTask) return;
      targetColumnId = overTask.columnId;
      targetLaneId = overTask.swimlaneId ?? null;
      const items = tasksInCell(targetColumnId, targetLaneId).filter((t) => t.id !== task.id);
      const idx = items.findIndex((t) => t.id === overTask.id);
      const fromAbove =
        task.columnId !== targetColumnId ||
        (task.swimlaneId ?? null) !== targetLaneId ||
        task.position < overTask.position;
      if (fromAbove) {
        beforeTaskId = overTask.id;
        afterTaskId = items[idx + 1]?.id;
      } else {
        afterTaskId = overTask.id;
        beforeTaskId = items[idx - 1]?.id;
      }
    }

    const sameCell = task.columnId === targetColumnId && (task.swimlaneId ?? null) === targetLaneId;
    if (sameCell) {
      const items = tasksInCell(targetColumnId, targetLaneId);
      const cur = items.findIndex((t) => t.id === task.id);
      if (items[cur - 1]?.id === beforeTaskId && items[cur + 1]?.id === afterTaskId) return;
    }

    const anchorBefore = beforeTaskId ? localTasks.find((t) => t.id === beforeTaskId) : undefined;
    const anchorAfter = afterTaskId ? localTasks.find((t) => t.id === afterTaskId) : undefined;
    const position =
      beforeTaskId || afterTaskId
        ? keyBetween(anchorBefore?.position ?? null, anchorAfter?.position ?? null)
        : keyAfter(
            localTasks
              .filter((t) => t.columnId === targetColumnId && t.id !== task.id)
              .sort(byPosition)
              .at(-1)?.position ?? null
          );

    const snapshot = localTasks;
    setLocalTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, columnId: targetColumnId, swimlaneId: targetLaneId, position } : t))
    );

    try {
      await onMoveTask(task.id, { columnId: targetColumnId, swimlaneId: targetLaneId, beforeTaskId, afterTaskId });
    } catch (err) {
      setLocalTasks(snapshot);
      if (isWipLimit(err)) {
        setFlashColumnId(targetColumnId);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashColumnId(null), 1500);
      } else {
        console.error("Task move failed", err);
      }
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="board-area">
        <div className="board-header">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-xl font-semibold text-lx-text-primary">{board.project.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <FilterButton board={board} filters={filters} onChange={setFilters} />
            <Link
              to="/$slug/settings"
              params={{ slug: board.project.slug }}
              search={{}}
              className="btn btn-ghost text-sm"
            >
              Settings
            </Link>
          </div>
        </div>
        {isFilterActive(filters) && <ActiveFilterBar board={board} filters={filters} onChange={setFilters} />}
        <div className="board-scroll">
        {columns.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <div className="empty-state-icon">
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16M15 4v16" />
              </svg>
            </div>
            <div className="empty-state-title">No columns yet</div>
            <div className="empty-state-desc">Add a column to start tracking tasks.</div>
            <Link
              to="/$slug/settings"
              params={{ slug: board.project.slug }}
              search={{}}
              className="btn btn-primary mt-4"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M12 5v14m-7-7h14" />
              </svg>
              Add Column
            </Link>
          </div>
        ) : (
          rows.map(({ lane }) => {
          const laneId = lane?.id ?? null;
          const laneTaskCount = hasLanes
            ? localTasks.filter((t) => (t.swimlaneId ?? null) === laneId).length
            : localTasks.length;
          const isCollapsed = laneId !== null && collapsed.has(laneId);
          return (
            <div key={laneId ?? "no-lane"}>
              {lane && (
                <SwimlaneHeader
                  name={lane.name}
                  count={laneTaskCount}
                  collapsed={isCollapsed}
                  onToggle={() => toggleLane(lane.id)}
                />
              )}
              {!isCollapsed && (
                <div className="columns-row">
                  {columns.map((col) => {
                    const cell = tasksInCell(col.id, laneId);
                    const dimmed = columnDimmed(col.id);
                    return (
                      <div className={cn("column", dimmed && "opacity-45")} key={col.id}>
                        <ColumnHeader
                          name={col.name}
                          color={col.color}
                          taskCount={cell.length}
                          wipLimit={col.wipLimit}
                          wipFlash={flashColumnId === col.id}
                          dimmed={dimmed}
                          onOpenCreate={() => onOpenCreateTask?.(col.id, laneId)}
                        />
                        <Column
                          id={cellDropId(col.id, laneId)}
                          data={{ type: "column", columnId: col.id, swimlaneId: laneId }}
                          isEmpty={cell.length === 0}
                          onOpenCreate={() => onOpenCreateTask?.(col.id, laneId)}
                        >
                          <SortableContext items={cell.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                            {cell.map((task) => (
                              <SortableTaskCard key={task.id} task={task} onSelect={onSelectTask} dimmed={cardDimmed(task)} />
                            ))}
                          </SortableContext>
                        </Column>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
        )}
        </div>
      </div>
      <DragOverlay dropAnimation={{ duration: 150, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {activeTask ? (
          <div style={{ width: 258 }}>
            <TaskCard {...cardProps(activeTask)} isDragging />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

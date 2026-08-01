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
import type { Board, Swimlane, Task } from "../../../shared/types";
import { keyAfter, keyBetween } from "../../../shared/positions";
import { cn } from "../ui/cn";
import { Column } from "./Column";
import { ColumnHeader } from "./ColumnHeader";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { TaskCard } from "./TaskCard";
import { FilterButton, ActiveFilterBar, emptyFilters, isFilterActive, type FilterState } from "./BoardFilters";
import { KanbanSettingsModal } from "./KanbanSettingsModal";
import { ColumnForm } from "./ColumnForm";
import { useArchiveTask, useCreateColumn, useRestoreTask } from "../../lib/queries";
import { Menu } from "../ui/Menu";
import { MoreHorizontal } from "lucide-react";
import { Archive, Trash2 } from "lucide-react";
import { useToast } from "../ui/Toast";

export interface MoveTarget {
  columnId: string;
  swimlaneId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
}

interface KanbanBoardProps {
  board: Board;
  showArchived?: boolean;
  onToggleArchived?: (show: boolean) => void;
  onMoveTask: (taskId: string, target: MoveTarget) => Promise<void>;
  onSelectTask?: (task: Task) => void;
  onOpenCreateTask?: (columnId: string, swimlaneId?: string) => void;
}

const byPosition = (a: Task, b: Task) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

const cellDropId = (columnId: string, laneId: string | null) => `cell:${laneId ?? "none"}:${columnId}`;

const isWipLimit = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === "WIP_LIMIT" || (typeof e.message === "string" && e.message.includes("WIP_LIMIT"));
};

const isRequiredField = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === "REQUIRED_FIELD" || (typeof e.message === "string" && e.message.includes("REQUIRED_FIELD"));
};

const isRejection = (err: unknown): boolean => isWipLimit(err) || isRequiredField(err);

function cardProps(task: Task, board: Board) {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    type: task.type,
    priorities: board.fieldConfig?.priorities ?? [],
    types: board.fieldConfig?.types ?? [],
    assignees: task.assignees,
    githubs: task.githubs,
  };
}

function SortableTaskCard({
  task,
  board,
  onSelect,
  dimmed,
  isNew,
  isShaking,
  onArchive,
  onRestore,
  onDelete,
}: {
  task: Task;
  board: Board;
  onSelect?: (t: Task) => void;
  dimmed: boolean;
  isNew?: boolean;
  isShaking?: boolean;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const archived = task.archivedAt != null;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card", columnId: task.columnId, swimlaneId: task.swimlaneId },
    disabled: archived,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "drag-source", isShaking && "lx-shake")}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (!isDragging && !archived) { e.stopPropagation(); onSelect?.(task); }
      }}
    >
      <TaskCard
        {...cardProps(task, board)}
        dimmed={dimmed}
        archived={archived}
        className={cn(isNew && "card-enter")}
        action={
          <Menu
            align="right"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                className={cn("icon-btn", open && "active")}
                onClick={(e) => { e.stopPropagation(); toggle(); }}
                title="Card menu"
                aria-label="Card menu"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {archived ? (
              <button type="button" className="menu-item" onClick={(e) => { e.stopPropagation(); onRestore?.(task.id); }}>
                <Archive size={14} />
                Restore
              </button>
            ) : (
              <button type="button" className="menu-item" onClick={(e) => { e.stopPropagation(); onArchive?.(task.id); }}>
                <Archive size={14} />
                Archive
              </button>
            )}
            <div className="menu-separator" />
            <button type="button" className="menu-item danger" onClick={(e) => { e.stopPropagation(); onDelete?.(task.id); }}>
              <Trash2 size={14} />
              Delete
            </button>
          </Menu>
        }
      />
    </div>
  );
}

export function KanbanBoard({ board, showArchived = false, onToggleArchived, onMoveTask, onSelectTask, onOpenCreateTask }: KanbanBoardProps) {
  const [localTasks, setLocalTasks] = useState<Task[]>(board.tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [flashColumnId, setFlashColumnId] = useState<string | null>(null);
  const [shakeTaskId, setShakeTaskId] = useState<string | null>(null);
  const [newTaskIds, setNewTaskIds] = useState<Set<string>>(new Set());
  const flashTimer = useRef<number | null>(null);
  const shakeTimer = useRef<number | null>(null);
  const prevTaskIds = useRef<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isColumnCreateOpen, setIsColumnCreateOpen] = useState(false);
  const createColumn = useCreateColumn(board.project.slug);
  const archiveTask = useArchiveTask(board.project.slug);
  const restoreTask = useRestoreTask(board.project.slug);
  const toast = useToast();

  useEffect(() => {
    const currentIds = new Set(localTasks.map((t) => t.id));
    const prev = prevTaskIds.current;
    const added = new Set<string>();
    for (const id of currentIds) if (!prev.has(id)) added.add(id);
    if (added.size > 0) {
      setNewTaskIds(added);
      const t = window.setTimeout(() => setNewTaskIds(new Set()), 200);
      return () => window.clearTimeout(t);
    }
    prevTaskIds.current = currentIds;
  }, [localTasks]);

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

  const columns = useMemo(() => board.columns.toSorted((a, b) => a.position - b.position), [board.columns]);
  const lanes = useMemo(() => board.swimlanes.toSorted((a, b) => a.position - b.position), [board.swimlanes]);
  const hasLanes = lanes.length > 0;

  const rows = useMemo<{ lane: Swimlane }[]>(() => {
    if (!hasLanes) return [];
    return lanes.map((lane) => ({ lane }));
  }, [hasLanes, lanes]);

  const tasksInCell = useCallback(
    (columnId: string, laneId: string) =>
      localTasks
        .filter((t) => t.columnId === columnId && t.swimlaneId === laneId)
        .sort(byPosition),
    [localTasks]
  );

  const columnTotalCount = useCallback(
    (columnId: string) => localTasks.filter((t) => t.columnId === columnId).length,
    [localTasks]
  );

  const columnDimmed = useCallback(
    (columnId: string) => filters.columns.size > 0 && !filters.columns.has(columnId),
    [filters.columns]
  );

  const cardDimmed = useCallback(
    (task: Task) => filters.columns.size > 0 && !filters.columns.has(task.columnId),
    [filters.columns]
  );

  const cardHidden = useCallback(
    (task: Task) => {
      if (filters.priorities.size > 0 && !filters.priorities.has(task.priority)) return true;
      if (filters.types.size > 0 && !filters.types.has(task.type)) return true;
      if (filters.assignees.size > 0 && !task.assignees.some((a) => filters.assignees.has(a))) return true;
      if (filters.swimlanes.size > 0 && !filters.swimlanes.has(task.swimlaneId)) return true;
      return false;
    },
    [filters]
  );


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
      | { type?: string; columnId?: string; swimlaneId?: string }
      | undefined;

    let targetColumnId: string;
    let targetLaneId: string;
    let beforeTaskId: string | undefined;
    let afterTaskId: string | undefined;

    if (overData?.type === "column") {
      targetColumnId = overData.columnId!;
      targetLaneId = overData.swimlaneId!;
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
      targetLaneId = overTask.swimlaneId;
      const items = tasksInCell(targetColumnId, targetLaneId).filter((t) => t.id !== task.id);
      const idx = items.findIndex((t) => t.id === overTask.id);
      const fromAbove =
        task.columnId !== targetColumnId ||
        task.swimlaneId !== targetLaneId ||
        task.position < overTask.position;
      if (fromAbove) {
        beforeTaskId = overTask.id;
        afterTaskId = items[idx + 1]?.id;
      } else {
        afterTaskId = overTask.id;
        beforeTaskId = items[idx - 1]?.id;
      }
    }

    const sameCell = task.columnId === targetColumnId && task.swimlaneId === targetLaneId;
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
      if (isRejection(err)) {
        setShakeTaskId(task.id);
        if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
        shakeTimer.current = window.setTimeout(() => setShakeTaskId(null), 200);
      }
      if (isWipLimit(err)) {
        setFlashColumnId(targetColumnId);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashColumnId(null), 1500);
        const column = board.columns.find((c) => c.id === targetColumnId);
        const limit = column?.wipLimit ?? 0;
        toast.push(
          "warning",
          "WIP limit exceeded",
          `${column?.name ?? "Column"} is at ${columnTotalCount(targetColumnId)}/${limit} tasks. Move blocked.`
        );
      }
      if (isRequiredField(err)) {
        const column = board.columns.find((c) => c.id === targetColumnId);
        const fields = (column?.requiredFields ?? []).join(", ");
        toast.push(
          "warning",
          "Required fields missing",
          `${column?.name ?? "Column"} requires: ${fields}.`
        );
      }
      if (!isRejection(err)) {
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
            <button
              type="button"
              className={cn("btn btn-ghost text-sm", showArchived && "active")}
              onClick={() => onToggleArchived?.(!showArchived)}
              title="Show archived tasks"
            >
              <span className={cn("toggle-switch", showArchived && "is-on")} />
              Show archived
            </button>
            <FilterButton board={board} filters={filters} onChange={setFilters} />
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={() => setIsSettingsOpen(true)}
            >
              Settings
            </button>
          </div>
        </div>
        {isFilterActive(filters) && <ActiveFilterBar board={board} filters={filters} onChange={setFilters} />}
        <div className={cn("board-scroll", columns.length === 0 && "items-center justify-center")}>
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
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => setIsColumnCreateOpen(true)}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M12 5v14m-7-7h14" />
              </svg>
              Add Column
            </button>
          </div>
        ) : (
          rows.map(({ lane }) => {
          const laneId = lane.id;
          const laneTaskCount = localTasks.filter((t) => t.swimlaneId === laneId).length;
          const isCollapsed = collapsed.has(laneId);
          return (
            <div key={laneId}>
              <SwimlaneHeader
                slug={board.project.slug}
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
                          slug={board.project.slug}
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
                          slug={board.project.slug}
                          columnId={col.id}
                          swimlaneId={laneId}
                          priorities={board.fieldConfig?.priorities ?? []}
                          types={board.fieldConfig?.types ?? []}
                          onOpenCreate={() => onOpenCreateTask?.(col.id, laneId)}
                        >
                          <SortableContext items={cell.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                            {cell.filter((task) => !cardHidden(task)).map((task) => (
                              <SortableTaskCard
                                key={task.id}
                                task={task}
                                board={board}
                                onSelect={onSelectTask}
                                dimmed={cardDimmed(task)}
                                isNew={newTaskIds.has(task.id)}
                                isShaking={shakeTaskId === task.id}
                                onArchive={(id) => archiveTask.mutate({ id })}
                                onRestore={(id) => restoreTask.mutate({ id })}
                              />
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
            <TaskCard {...cardProps(activeTask, board)} isDragging />
          </div>
        ) : null}
      </DragOverlay>
      <KanbanSettingsModal
        slug={board.project.slug}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
      <ColumnForm
        slug={board.project.slug}
        column={null}
        isOpen={isColumnCreateOpen}
        onClose={() => setIsColumnCreateOpen(false)}
        onSubmit={(input) => {
          createColumn.mutate({
            name: input.name,
            wipLimit: input.wipLimit,
            requiredFields: input.requiredFields,
            color: input.color ?? undefined,
            githubState: (input.githubState as "open" | "closed" | null | undefined) ?? undefined,
          });
        }}
      />
    </DndContext>
  );
}

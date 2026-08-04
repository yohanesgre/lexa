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
import { BoardLane } from "./BoardLane";
import { BoardToolbar } from "./BoardToolbar";
import { TaskCard } from "./TaskCard";
import { emptyFilters, isFilterActive, type FilterState } from "../../lib/filters";
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

// Link maps derived from board.links: children per parent, blocked-by titles per task.
function useLinkMaps(board: Board) {
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
    return { childrenByParent, parentOf, blockedBy };
  }, [board]);
}

const EMPTY_BLOCKED_BY: string[] = [];


function BoardEmptyState({ onAddColumn }: { onAddColumn: () => void }) {
  return (
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
        onClick={onAddColumn}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M12 5v14m-7-7h14" />
        </svg>
        Add Column
      </button>
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
  const [collapsedParents, setCollapsedParents] = useState<ReadonlySet<string>>(new Set());
  const { childrenByParent, blockedBy } = useLinkMaps(board);
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
        <BoardToolbar
          board={board}
          showArchived={showArchived}
          filters={filters}
          onToggleArchived={onToggleArchived!}
          onFiltersChange={setFilters}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />

        <div className={cn("board-scroll", columns.length === 0 && "items-center justify-center")}>
        {columns.length === 0 ? (
          <BoardEmptyState onAddColumn={() => setIsColumnCreateOpen(true)} />
        ) : (
          rows.map(({ lane }) => (
            <BoardLane
              key={lane.id}
              slug={board.project.slug}
              lane={lane}
              columns={columns}
              board={board}
              localTasks={localTasks}
              childrenByParent={childrenByParent}
              blockedBy={blockedBy}
              cardHidden={cardHidden}
              cardDimmed={cardDimmed}
              columnTotalCount={columnTotalCount}
              columnDimmed={columnDimmed}
              cellDropId={cellDropId}
              flashColumnId={flashColumnId}
              collapsed={collapsed}
              toggleLane={toggleLane}
              onOpenCreateTask={onOpenCreateTask}
              onSelectTask={onSelectTask!}
              newTaskIds={newTaskIds}
              shakeTaskId={shakeTaskId}
              archiveTask={archiveTask}
              restoreTask={restoreTask}
              collapsedParents={collapsedParents as Set<string>}
              setCollapsedParents={setCollapsedParents}
            />
          ))

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
      {isColumnCreateOpen && (
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
      )}
    </DndContext>
  );
}

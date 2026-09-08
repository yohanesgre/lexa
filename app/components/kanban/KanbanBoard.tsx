import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Board, Task } from "../../../shared/types";
import { BoardToolbar } from "./BoardToolbar";
import { MilestoneSelector } from "./MilestoneSelector";
import { KanbanSettingsModal } from "./KanbanSettingsModal";
import { MoveConfirmDialog } from "./MoveConfirmDialog";
import { ColumnForm } from "./ColumnForm";
import { TaskCard } from "./TaskCard";
import { BoardGrid } from "./board-grid";
import { computeDropTarget, computeDropPosition, type MoveTarget } from "./board-drop";
import { byPosition, cardProps, cellDropId, tasksReducer, useLinkMaps } from "./board-utils";
import { emptyFilters, type FilterState } from "../../lib/filters";
import { useArchiveTask, useCreateColumn, useRestoreTask } from "../../lib/queries";
import { useMoveGuard } from "../../lib/useMoveGuard";

export type { MoveTarget } from "./board-drop";

interface KanbanBoardProps {
  board: Board;
  showArchived?: boolean | undefined;
  onToggleArchived?: (show: boolean) => void;
  onMoveTask: (taskId: string, target: MoveTarget) => Promise<void>;
  onSelectTask?: (task: Task) => void;
  onOpenCreateTask?: (columnId: string, swimlaneId?: string) => void;
  milestoneId?: string | null | undefined;
  onMilestoneChange?: (id: string | null) => void;
}

export function KanbanBoard({ board, showArchived = false, onToggleArchived, onMoveTask, onSelectTask, onOpenCreateTask, milestoneId = null, onMilestoneChange }: KanbanBoardProps) {
  const [localTasks, dispatch] = useReducer(tasksReducer, board.tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shakeTaskId, setShakeTaskId] = useState<string | null>(null);
  const [flashColumnId, setFlashColumnId] = useState<string | null>(null);
  const [newTaskIds, setNewTaskIds] = useState<Set<string>>(new Set());
  const flashTimer = useRef<number | null>(null);
  const shakeTimer = useRef<number | null>(null);
  const prevTaskIds = useRef<Set<string>>(new Set());
  // Invalid drop feedback (DESIGN_SYSTEM: 200ms horizontal shake) + revert:
  // the optimistic move lives in localTasks, so when the server rejects the
  // mutation the board resets from the untouched (authoritative) cache.
  const revertMove = useCallback(
    (taskId: string) => {
      dispatch({ type: "set", tasks: board.tasks });
      setShakeTaskId(taskId);
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
      shakeTimer.current = window.setTimeout(() => setShakeTaskId(null), 200);
    },
    [board.tasks]
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [collapsedParents, setCollapsedParents] = useState<ReadonlySet<string>>(new Set());
  const { childrenByParent, blockedBy } = useLinkMaps(board);
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isColumnCreateOpen, setIsColumnCreateOpen] = useState(false);
  const createColumn = useCreateColumn(board.project.slug);
  const archiveTask = useArchiveTask(board.project.slug);
  const restoreTask = useRestoreTask(board.project.slug);
  const { confirmMove, pending, resolve, cancel } = useMoveGuard(board.project.slug, board);

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
    dispatch({ type: "set", tasks: board.tasks });
  }, [board.tasks]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    },
    []
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const columns = useMemo(() => board.columns.toSorted((a, b) => a.position - b.position), [board.columns]);
  const lanes = useMemo(() => board.swimlanes.toSorted((a, b) => a.position - b.position), [board.swimlanes]);
  const liveLanes = useMemo(() => lanes.filter((l) => !l.archivedAt), [lanes]);
  const archivedLanes = useMemo(() => lanes.filter((l) => !!l.archivedAt), [lanes]);
  // Milestone filter: the Backlog lane is always visible; sprint lanes render
  // only when they match the selection ("No milestone" shows loose sprints).
  const visibleLiveLanes = useMemo(() => {
    if (milestoneId === null) return liveLanes.filter((l) => l.kind === "backlog" || l.milestoneId === null);
    return liveLanes.filter((l) => l.kind === "backlog" || l.milestoneId === milestoneId);
  }, [liveLanes, milestoneId]);
  const hasLanes = visibleLiveLanes.length > 0;

  const rows = useMemo<{ lane: Board["swimlanes"][number] }[]>(() => {
    if (!hasLanes) return [];
    return visibleLiveLanes.map((lane) => ({ lane }));
  }, [hasLanes, visibleLiveLanes]);

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
    [filters.priorities, filters.types, filters.assignees, filters.swimlanes]
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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    const task = localTasks.find((t) => t.id === String(active.id));
    if (!task || !over || String(over.id) === task.id) return;

    const target = computeDropTarget(task, over, tasksInCell, localTasks);
    if (!target) return;

    const sameCell = task.columnId === target.columnId && task.swimlaneId === target.swimlaneId;
    if (sameCell) {
      const items = tasksInCell(target.columnId, target.swimlaneId);
      const cur = items.findIndex((t) => t.id === task.id);
      if (items[cur - 1]?.id === target.beforeTaskId && items[cur + 1]?.id === target.afterTaskId) return;
    }

    const position = computeDropPosition(task, target, localTasks);
    // The move guard fires the mutation itself on the free path and returns
    // the in-flight promise; when it returns false the confirm dialog is
    // pending and commits later (resolve) without any optimistic local state.
    const commit = confirmMove(task, target);
    if (!commit) return;
    dispatch({ type: "move", taskId: task.id, columnId: target.columnId, swimlaneId: target.swimlaneId, position });
    void commit.catch(() => revertMove(task.id));
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
          milestoneSelector={
            onMilestoneChange ? (
              <MilestoneSelector
                milestones={board.milestones}
                value={milestoneId}
                onChange={onMilestoneChange}
                slug={board.project.slug}
              />
            ) : undefined
          }
        />
        <BoardGrid
          slug={board.project.slug}
          board={board}
          columns={columns}
          rows={rows}
          archivedLanes={archivedLanes}
          showArchived={!!showArchived}
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
          {...(onOpenCreateTask !== undefined ? { onOpenCreateTask } : {})}
          onSelectTask={onSelectTask!}
          newTaskIds={newTaskIds}
          shakeTaskId={shakeTaskId}
          archiveTask={archiveTask}
          restoreTask={restoreTask}
          collapsedParents={collapsedParents as Set<string>}
          setCollapsedParents={setCollapsedParents}
          onAddColumn={() => setIsColumnCreateOpen(true)}
        />
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
      <MoveConfirmDialog board={board} pending={pending} resolve={resolve} cancel={cancel} />
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
              isDone: input.isDone ?? false,
            });
          }}
        />
      )}
    </DndContext>
  );
}
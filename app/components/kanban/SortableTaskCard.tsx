import { memo, useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Board, Task } from "../../../shared/types";
import { cn } from "../ui/cn";
import { TaskCard } from "./TaskCard";
import { MoreHorizontal, Archive, Trash2 } from "lucide-react";
import { Menu } from "../ui/Menu";

function cardProps(task: Task, board: Board) {
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

const EMPTY_BLOCKED_BY: string[] = [];

const CardMenu = memo(function CardMenu({
  archived,
  taskId,
  onArchive,
  onRestore,
  onDelete,
}: {
  archived: boolean;
  taskId: string;
  onArchive?: ((id: string) => void) | undefined;
  onRestore?: ((id: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
}) {
  return (
    <Menu
      align="right"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cn("icon-btn", open && "active")}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          title="Card menu"
          aria-label="Card menu"
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    >
      {archived ? (
        <button type="button" className="menu-item" onClick={(e) => { e.stopPropagation(); onRestore?.(taskId); }}>
          <Archive size={14} />
          Restore
        </button>
      ) : (
        <button type="button" className="menu-item" onClick={(e) => { e.stopPropagation(); onArchive?.(taskId); }}>
          <Archive size={14} />
          Archive
        </button>
      )}
      <div className="menu-separator" />
      <button type="button" className="menu-item danger" onClick={(e) => { e.stopPropagation(); onDelete?.(taskId); }}>
        <Trash2 size={14} />
        Delete
      </button>
    </Menu>
  );
});

export function SortableTaskCard({
  task,
  board,
  onSelect,
  dimmed,
  isNew,
  isShaking,
  onArchive,
  onRestore,
  onDelete,
  isSubtask = false,
  blockedBy = EMPTY_BLOCKED_BY,
  subtaskCount = 0,
  onToggleSubtasks,
  subtasksCollapsed = false,
}: {
  task: Task;
  board: Board;
  onSelect?: (t: Task) => void;
  dimmed: boolean;
  isNew?: boolean | undefined;
  isShaking?: boolean | undefined;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
  isSubtask?: boolean | undefined;
  blockedBy?: string[];
  subtaskCount?: number | undefined;
  onToggleSubtasks?: () => void;
  subtasksCollapsed?: boolean | undefined;
}) {
  const archived = task.archivedAt != null;
  const cardPropsMemo = useMemo(() => cardProps(task, board), [task, board]);
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
      role="button"
      tabIndex={0}
      aria-label={`Open task ${task.title}`}
      onClick={(e) => {
        if (!isDragging && !archived) { e.stopPropagation(); onSelect?.(task); }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !isDragging && !archived) {
          e.preventDefault();
          e.stopPropagation();
          onSelect?.(task);
        }
      }}
    >
      <TaskCard
        {...cardPropsMemo}
        dimmed={dimmed}
        archived={archived}
        isSubtask={isSubtask}
        blockedBy={blockedBy}
        subtaskCount={subtaskCount}
        onToggleSubtasks={onToggleSubtasks}
        subtasksCollapsed={subtasksCollapsed}
        className={cn(isNew && "card-enter")}
        action={<CardMenu archived={archived} taskId={task.id} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />}
      />
    </div>
  );
}
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
  isNew?: boolean;
  isShaking?: boolean;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
  isSubtask?: boolean;
  blockedBy?: string[];
  subtaskCount?: number;
  onToggleSubtasks?: () => void;
  subtasksCollapsed?: boolean;
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
        {...cardProps(task, board)}
        dimmed={dimmed}
        archived={archived}
        isSubtask={isSubtask}
        blockedBy={blockedBy}
        subtaskCount={subtaskCount}
        onToggleSubtasks={onToggleSubtasks}
        subtasksCollapsed={subtasksCollapsed}
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
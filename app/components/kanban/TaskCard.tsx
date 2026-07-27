import { GripVertical } from "lucide-react";
import { cn } from "../ui/cn";
import type { Priority, TaskType } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  title: string;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  githubOutOfSync: boolean;
  isDragging?: boolean;
}

const typeConfig: Record<TaskType, { label: string; badge: string; border: string }> = {
  feature: { label: "Feature", badge: "type-feature", border: "border-l-lx-type-feature" },
  bug: { label: "Bug", badge: "type-bug", border: "border-l-lx-type-bug" },
  task: { label: "Task", badge: "type-task", border: "border-l-lx-type-task" },
  asset: { label: "Asset", badge: "type-asset", border: "border-l-lx-type-asset" },
};

const priorityDot: Record<Priority, string> = {
  urgent: "priority-dot priority-urgent",
  high: "priority-dot priority-high",
  medium: "priority-dot priority-medium",
  low: "priority-dot priority-low",
};

export function TaskCard({ title, priority, type, assignee, githubOutOfSync, isDragging = false }: TaskCardProps) {
  const { label, badge, border } = typeConfig[type];
  return (
    <div className={cn("kanban-card border-l-[3px]", border, isDragging && "state-dragging")}>
      <span className={cn("type-badge", badge)}>{label}</span>
      <span
        className={cn("absolute top-[10px] right-[10px]", priorityDot[priority])}
        title={`${priority[0].toUpperCase()}${priority.slice(1)} priority`}
      />
      <div className="card-title mt-2">{title}</div>
      {(assignee || githubOutOfSync) && (
        <div className="card-meta">
          {assignee && <div className="avatar">{assignee[0].toUpperCase()}</div>}
          {githubOutOfSync && <span className="sync-dot sync-diverged" title="Out of sync with GitHub" />}
        </div>
      )}
      <GripVertical className="drag-handle" strokeWidth={1.5} />
    </div>
  );
}

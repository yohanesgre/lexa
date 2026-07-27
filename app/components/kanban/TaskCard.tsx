import { GripVertical, Bug, Lightbulb, CheckSquare, Box, type LucideIcon } from "lucide-react";
import { cn } from "../ui/cn";
import type { Priority, TaskType } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  title: string;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  githubOutOfSync: boolean;
  description: string;
  isDragging?: boolean;
}

const typeConfig: Record<TaskType, { label: string; badge: string; border: string; Icon: LucideIcon }> = {
  feature: { label: "Feature", badge: "type-feature", border: "border-l-lx-type-feature", Icon: Lightbulb },
  bug: { label: "Bug", badge: "type-bug", border: "border-l-lx-type-bug", Icon: Bug },
  task: { label: "Task", badge: "type-task", border: "border-l-lx-type-task", Icon: CheckSquare },
  asset: { label: "Asset", badge: "type-asset", border: "border-l-lx-type-asset", Icon: Box },
};

const priorityDot: Record<Priority, string> = {
  urgent: "priority-dot priority-urgent",
  high: "priority-dot priority-high",
  medium: "priority-dot priority-medium",
  low: "priority-dot priority-low",
};

export function TaskCard({ title, priority, type, assignee, githubOutOfSync, description, isDragging = false }: TaskCardProps) {
  const { label, badge, border, Icon } = typeConfig[type];
  return (
    <div className={cn("kanban-card border-l-[3px]", border, isDragging && "state-dragging")}>
      <div className="flex items-center justify-between">
        <span className={cn("type-badge gap-1", badge)}>
          <Icon size={10} strokeWidth={2} />
          {label}
        </span>
        <span className={priorityDot[priority]} title={`${priority} priority`} />
      </div>
      <div className="card-title mt-2">{title}</div>
      {description && <p className="mt-1 truncate text-sm text-lx-text-secondary">{description}</p>}
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

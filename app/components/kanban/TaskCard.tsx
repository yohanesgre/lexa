import { cn } from "../ui/cn";
import type { Priority, TaskType } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  title: string;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  github: {
    issueNumber: number;
    repo: string;
    url: string;
    outOfSync: boolean;
  } | null;
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

function GithubMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export function TaskCard({ title, priority, type, assignee, github, githubOutOfSync, isDragging = false }: TaskCardProps) {
  const { label, badge, border } = typeConfig[type];
  const isOutOfSync = github?.outOfSync ?? githubOutOfSync;
  return (
    <div className={cn("kanban-card border-l-[3px]", border, isDragging && "state-dragging")}>
      <div className="flex items-center justify-between">
        <span className={cn("type-badge", badge)}>{label}</span>
        <span
          className={cn("priority-dot", priorityDot[priority])}
          title={`${priority[0].toUpperCase()}${priority.slice(1)} priority`}
        />
      </div>
      <div className="card-title mt-2">{title}</div>
      <div className="card-meta">
        {assignee && <div className="avatar">{assignee[0].toUpperCase()}</div>}
        {github && (
          <span className="github-badge">
            <GithubMark />
            #{github.issueNumber}
          </span>
        )}
        {github && (
          <span
            className={cn("sync-dot", isOutOfSync ? "sync-diverged" : "sync-synced")}
            title={isOutOfSync ? "Out of sync with GitHub" : "Synced with GitHub"}
          />
        )}
      </div>
    </div>
  );
}

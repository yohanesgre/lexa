import { cn } from "../ui/cn";
import type { Priority, TaskType, GithubIssue } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  title: string;
  priority: Priority;
  type: TaskType;
  assignees: string[];
  githubs: GithubIssue[];
  isDragging?: boolean;
  dimmed?: boolean;
  className?: string;
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

export function TaskCard({ title, priority, type, assignees, githubs, isDragging = false, dimmed = false, className }: TaskCardProps) {
  const { label, badge, border } = typeConfig[type];
  const hasOutOfSync = githubs.some(g => g.outOfSync);
  return (
    <div className={cn("kanban-card border-l-[3px]", border, isDragging && "state-dragging", dimmed && "opacity-45", className)}>
      <div className="flex items-center justify-between">
        <span className={cn("type-badge", badge)}>{label}</span>
        <span
          className={cn("priority-dot", priorityDot[priority])}
          title={`${priority[0].toUpperCase()}${priority.slice(1)} priority`}
        />
      </div>
      <div className="card-title mt-2">{title}</div>
      <div className="card-meta">
        <div className="card-assignees">
          {assignees.slice(0, 3).map((a) => (
            <div className="avatar" key={a}>{a.slice(0, 2).toUpperCase()}</div>
          ))}
          {assignees.length > 3 && <span className="card-assignees-overflow">+{assignees.length - 3}</span>}
        </div>
        <div className="card-meta-spacer" />
        <div className="card-gh-issues">
          {githubs.slice(0, 2).map(g => (
            <span className="github-badge" key={g.issueId}>
              <GithubMark />
              #{g.issueNumber}
            </span>
          ))}
          {githubs.length > 2 && <span className="card-gh-overflow">+{githubs.length - 2}</span>}
        </div>
        {githubs.length > 0 && (
          <span
            className={cn("sync-dot", hasOutOfSync ? "sync-diverged" : "sync-synced")}
            title={hasOutOfSync ? "Out of sync with GitHub" : "Synced with GitHub"}
          />
        )}
      </div>
    </div>
  );
}

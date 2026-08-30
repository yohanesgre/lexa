import { memo } from "react";
import { cn } from "../ui/cn";
import { formatDueLabel } from "../../lib/dates";
import type { GithubIssue, FieldOption } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  taskKey: string;                // "EG-12" — stable ticket identifier
  title: string;
  priority: string;               // priority_options.id
  type: string;                   // type_options.id
  priorities: FieldOption[];      // from board.fieldConfig
  types: FieldOption[];
  assignees: string[];
  githubs: GithubIssue[];
  dueAt?: string | null | undefined;
  isDragging?: boolean | undefined;
  dimmed?: boolean | undefined;
  archived?: boolean | undefined;
  isSubtask?: boolean | undefined;            // render indented + dimmed
  blockedBy?: string[] | undefined;           // blocker task titles (informational)
  subtaskCount?: number | undefined;          // children count for the parent chevron
  onToggleSubtasks?: (() => void) | undefined;
  subtasksCollapsed?: boolean | undefined;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

function GithubMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export const TaskCard = memo(function TaskCard({ taskKey, title, priority, type, priorities, types, assignees, githubs, dueAt, isDragging = false, dimmed = false, archived = false, isSubtask = false, blockedBy = [], subtaskCount = 0, onToggleSubtasks, subtasksCollapsed = false, action, className }: TaskCardProps) {
  const typeOpt = types.find((t) => t.id === type);
  const prioOpt = priorities.find((p) => p.id === priority);
  const typeLabel = typeOpt?.label ?? type;
  const typeColor = typeOpt?.color ?? "#6B6560";
  const prioColor = prioOpt?.color ?? "#6B6560";
  // Legacy default Low renders as a hollow ring, never a solid dot (§5.5/§5.9i).
  const isLowPriority = prioColor.toUpperCase() === "#6B6560";
  const hasOutOfSync = githubs.some(g => g.outOfSync);
  const due = dueAt ? formatDueLabel(dueAt) : null;
  return (
    <div className={cn("kanban-card border-l-[3px]", isSubtask && "kanban-card-subtask", isDragging && "state-dragging", dimmed && "opacity-45", archived && "state-archived", className)}
      style={{ borderLeftColor: typeColor }}>
      <div className="flex items-center justify-between">
        <span
          className="type-badge"
          style={{ background: `${typeColor}1a`, color: typeColor }}
        >
          {typeLabel}
        </span>
        <span className="flex items-center gap-1">
          {blockedBy.length > 0 && (
            <span
              className="sync-dot sync-diverged"
              title={`Blocked by: ${blockedBy.join(", ")}`}
              style={{ cursor: "help" }}
            />
          )}
          <span
            className="priority-dot"
            style={isLowPriority ? { border: "2px solid #6B6560", background: "transparent" } : { background: prioColor }}
            title={`${typeLabel} · ${prioOpt?.label ?? priority}`}
          />
          {action}
        </span>
      </div>
      <div className="card-title mt-2">
        {subtaskCount > 0 && (
          <button
            type="button"
            className="inline-flex items-center justify-center mr-1 text-lx-text-muted cursor-pointer"
            style={{ width: 16, height: 16, border: "none", background: "none", padding: 0 }}
            title={subtasksCollapsed ? "Expand subtasks" : "Collapse subtasks"}
            aria-label={subtasksCollapsed ? "Expand subtasks" : "Collapse subtasks"}
            onClick={(e) => { e.stopPropagation(); onToggleSubtasks?.(); }}
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: subtasksCollapsed ? "rotate(-90deg)" : "none", transition: "transform 100ms" }}
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}
        {taskKey && <span className="task-key">{taskKey}</span>}
        {" "}
        {title}
        {subtaskCount > 0 && <span className="font-micro text-2xs text-lx-text-muted" style={{ marginLeft: 6 }}>{String(subtaskCount).padStart(2, "0")}</span>}
      </div>
      <div className="card-meta">
        <div className="card-assignees">
          {assignees.slice(0, 3).map((a) => (
            <div className="avatar" key={a}>{a.slice(0, 2).toUpperCase()}</div>
          ))}
          {assignees.length > 3 && <span className="card-assignees-overflow">+{assignees.length - 3}</span>}
        </div>
        {due && (
          <span className={cn("card-due", due.overdue && "card-due-overdue")}>{due.text}</span>
        )}
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
});

import { cn } from "../ui/cn";
import type { GithubIssue, FieldOption } from "../../../shared/types";

interface TaskCardProps {
  id: string;
  title: string;
  priority: string;               // priority_options.id
  type: string;                   // type_options.id
  priorities: FieldOption[];      // from board.fieldConfig
  types: FieldOption[];
  assignees: string[];
  githubs: GithubIssue[];
  isDragging?: boolean;
  dimmed?: boolean;
  archived?: boolean;
  action?: React.ReactNode;
  className?: string;
}

function GithubMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export function TaskCard({ title, priority, type, priorities, types, assignees, githubs, isDragging = false, dimmed = false, archived = false, action, className }: TaskCardProps) {
  const typeOpt = types.find((t) => t.id === type);
  const prioOpt = priorities.find((p) => p.id === priority);
  const typeLabel = typeOpt?.label ?? type;
  const typeColor = typeOpt?.color ?? "#6b7280";
  const prioColor = prioOpt?.color ?? "#6b6560";
  const hasOutOfSync = githubs.some(g => g.outOfSync);
  return (
    <div className={cn("kanban-card border-l-[3px]", isDragging && "state-dragging", dimmed && "opacity-45", archived && "state-archived", className)}
      style={{ borderLeftColor: typeColor }}>
      <div className="flex items-center justify-between">
        <span
          className="type-badge"
          style={{ background: `${typeColor}1a`, color: typeColor }}
        >
          {typeLabel}
        </span>
        <span className="flex items-center gap-1">
          <span
            className="priority-dot"
            style={{ background: prioColor }}
            title={`${typeLabel} · ${prioColor}`}
          />
          {action}
        </span>
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

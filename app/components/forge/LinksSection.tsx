import { useMemo, useState } from "react";
import { Link2, X } from "lucide-react";
import { useAddTaskLink, useRemoveTaskLink, useTaskLinks, useTaskSearch } from "../../lib/queries";
import { cn } from "../ui/cn";
import type { TaskLinkRelation } from "../../../shared/types";

const RELATION_LABELS: Record<TaskLinkRelation, string> = {
  subtask_of: "subtask",
  blocked_by: "blocked by",
  related_to: "related",
};

interface LinksSectionProps {
  slug: string;
  taskId: string;
  taskTitleById?: Map<string, string>;  // from the board — for link display
  className?: string;
}

export function LinksSection({ slug, taskId, taskTitleById, className }: LinksSectionProps) {
  const { data: links = [] } = useTaskLinks(slug, taskId);
  const addLink = useAddTaskLink(slug, taskId);
  const removeLink = useRemoveTaskLink(slug, taskId);

  const [query, setQuery] = useState("");
  const [relation, setRelation] = useState<TaskLinkRelation>("related_to");
  const [focused, setFocused] = useState(false);
  const { data: suggestions = [] } = useTaskSearch(slug, query, taskId);

  // Map link id → target task id (the "other" task) for display.
  const targetOf = useMemo(() => {
    const m = new Map<string, { otherTaskId: string; relation: TaskLinkRelation }>();
    for (const l of links) {
      const otherTaskId = l.fromTaskId === taskId ? l.toTaskId : l.fromTaskId;
      m.set(l.id, { otherTaskId, relation: l.relation });
    }
    return m;
  }, [links, taskId]);

  const displayTitle = (otherTaskId: string) => {
    const fromBoard = taskTitleById?.get(otherTaskId);
    if (fromBoard) return fromBoard;
    const s = suggestions.find((x) => x.id === otherTaskId);
    return s?.title ?? otherTaskId.slice(0, 8);
  };

  return (
    <div className={cn(className)}>
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} strokeWidth={1.5} className="text-lx-text-muted" />
        <span className="prop-label">Links</span>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">subtasks · blocked · related</span>
      </div>

      {links.map((link) => {
        const info = targetOf.get(link.id);
        if (!info) return null;
        return (
          <div
            key={link.id}
            className="flex items-center justify-between"
            style={{
              padding: "6px 10px",
              background: link.relation === "blocked_by" ? "var(--lx-bg-warning-subtle)" : "var(--lx-surface-elevated)",
              border: "1px solid var(--lx-border-default)",
              borderRadius: 6,
              marginBottom: 4,
            }}
          >
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{RELATION_LABELS[link.relation]}</span>
              <span className="text-sm text-lx-text-secondary truncate">{displayTitle(info.otherTaskId)}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="Remove link"
              aria-label="Remove link"
              style={{ width: 20, height: 20 }}
              onClick={() => removeLink.mutate(link.id)}
            >
              <X size={10} strokeWidth={2} />
            </button>
          </div>
        );
      })}

      {links.length === 0 && (
        <div className="text-xs text-lx-text-muted mb-2">
          No links yet. Type a task title and press Enter to link a subtask, blocker, or related task.
        </div>
      )}

      <div style={{ position: "relative" }}>
        <div className="flex items-center gap-2 mt-2">
          <input
            className="prop-input"
            placeholder="Add link — type a task title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && suggestions.length > 0) {
                e.preventDefault();
                addLink.mutate({ toTaskId: suggestions[0].id, relation });
                setQuery("");
              }
            }}
            style={{ flex: 1, height: 28, fontSize: 12, minWidth: 0 }}
          />
          <select
            className="prop-input"
            value={relation}
            onChange={(e) => setRelation(e.target.value as TaskLinkRelation)}
            style={{ width: 110, height: 28, fontSize: 12, flexShrink: 0 }}
          >
            <option value="related_to">Related to</option>
            <option value="subtask_of">Subtask of</option>
            <option value="blocked_by">Blocked by</option>
          </select>
        </div>

        {focused && query.trim().length >= 2 && suggestions.length > 0 && (
          <div className="menu-popover" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30 }}>
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className="menu-item"
                onClick={() => {
                  addLink.mutate({ toTaskId: s.id, relation });
                  setQuery("");
                }}
              >
                <span className="truncate" style={{ flex: 1 }}>{s.title}</span>
                <span className="text-xs text-lx-text-muted flex-shrink-0">{s.columnName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

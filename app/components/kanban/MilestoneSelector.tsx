import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink } from "lucide-react";
import { cn } from "../ui/cn";
import type { Milestone } from "../../../shared/types";

interface MilestoneSelectorProps {
  milestones: Milestone[];
  value: string | null;
  onChange: (id: string | null) => void;
  slug: string;
}

// Board-header milestone selector — wireframe kanban.html. Defaults to the
// active milestone (first non-archived); "No milestone" shows loose sprints +
// Backlog; archived milestones dimmed; "Manage milestones" deep-links.
export function MilestoneSelector({ milestones, value, onChange, slug }: MilestoneSelectorProps) {
  const active = milestones.find((m) => !m.archivedAt);
  const selected = milestones.find((m) => m.id === value) ?? null;

  const triggerLabel = selected ? (
    <>
      {selected.name}
      <span className="ms-count" style={{ marginLeft: 4, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)" }}>
        {selected.archivedSprintCount}/{selected.sprintCount} archived
      </span>
    </>
  ) : (
    <>
      No milestone
      <span className="ms-count" style={{ marginLeft: 4, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)" }}>
        loose sprints + Backlog
      </span>
    </>
  );

  return (
    <div className="ms-selector" style={{ marginLeft: 8 }}>
      <details className="ms-selector-details">
        <summary className="ms-selector-trigger" title="Filter board by milestone">
          {triggerLabel}
          <ChevronDown size={12} strokeWidth={2} />
        </summary>
        <div className="ms-selector-popover">
          <button
            type="button"
            className={cn("ms-option", value === null && "active")}
            style={{ color: "var(--lx-text-secondary)", width: "100%" }}
            onClick={() => onChange(null)}
          >
            No milestone
            <span className="ms-count">loose sprints + Backlog</span>
          </button>
          <div className="menu-separator" />
          {milestones.map((m) => (
            <button
              key={m.id}
              type="button"
              className={cn("ms-option", m.id === value && "active", !!m.archivedAt && "archived")}
              style={{ width: "100%" }}
              onClick={() => onChange(m.id)}
            >
              {m.name}
              {m.archivedAt && <span className="ms-count">(archived)</span>}
              <span className="ms-count">
                {m.sprintCount === 0 ? "" : `${m.archivedSprintCount}/${m.sprintCount} sprints archived`}
              </span>
            </button>
          ))}
          <div className="menu-separator" />
          <Link
            to="/$slug/milestones"
            params={{ slug }}
            search={{}}
            className="ms-option"
            style={{ color: "var(--lx-text-link)", textDecoration: "none", width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            Manage milestones
            <ExternalLink size={12} strokeWidth={2} style={{ marginLeft: "auto" }} />
          </Link>
        </div>
      </details>
    </div>
  );
}

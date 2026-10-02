import { Link } from "@tanstack/react-router";
import { formatDueChip } from "../../lib/dates";
import { cn } from "../ui/cn";
import { MilestoneProgress } from "./MilestoneProgress";
import type { Milestone } from "../../../shared/types";

interface MilestoneCardProps {
  slug: string;
  milestone: Milestone | null;
}

// Read-only active-milestone summary card (wireframe home.html §6.6): name,
// sprints archived X/Y + tasks-done progress, due date (red when overdue),
// "Manage milestones" link. Hidden entirely when there's no active milestone.
export function MilestoneCard({ slug, milestone }: MilestoneCardProps) {
  if (!milestone) return null;
  const due = milestone.dueAt ? formatDueChip(milestone.dueAt) : null;
  const tasks = { done: milestone.tasksDone, total: milestone.tasksTotal };
  const overdue = due?.overdue ?? false;

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        className={cn("card-panel")}
        style={!overdue ? { borderColor: "var(--lx-border-focus)", boxShadow: "var(--lx-focus-glow)" } : undefined}
      >
        <div className="flex items-center gap-3">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="flex items-center gap-2">
              <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Active milestone
              </span>
              {due ? (
                <span className={cn("milestone-due", overdue && "milestone-due-overdue")}>{due.text}</span>
              ) : (
                <span className="milestone-due" style={{ borderColor: "var(--lx-border-default)", color: "var(--lx-text-muted)" }}>
                  no due date
                </span>
              )}
            </div>
            <div className="milestone-name" style={{ marginTop: 4 }}>{milestone.name}</div>
            <MilestoneProgress
              sprintsArchived={milestone.archivedSprintCount}
              sprintsTotal={milestone.sprintCount}
              tasksDone={tasks.done}
              tasksTotal={tasks.total}
            />
          </div>
          <Link to="/$slug/milestones" params={{ slug }} search={{}} className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}>
            Manage milestones
          </Link>
        </div>
      </div>
    </div>
  );
}

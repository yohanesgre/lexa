import { Link } from "@tanstack/react-router";
import { cn } from "./ui/cn";
import type { Project } from "../../shared/types";
import type { ProjectHealth } from "../lib/dashboard-stubs";

function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

interface ProjectCardProps {
  project: Project;
  health?: ProjectHealth;
  className?: string;
}

export function ProjectCard({ project, health, className }: ProjectCardProps) {
  return (
    <Link to="/$slug" params={{ slug: project.slug }} search={{}} className={cn("project-card health-card", className)}>
      {project.githubRepo && (
        <div className="health-card-gh">
          <GithubMark />
        </div>
      )}
      <h2 className="project-card-name">{project.name}</h2>
      <p className="project-card-desc">{project.description}</p>
      {health && (
        <>
          <div className="health-card-status-row">
            <span className={cn("health-dot", `health-dot-${health.health}`)} />
            {health.urgentCount > 0 && (
              <span className="health-metric health-metric-urgent">
                {String(health.urgentCount).padStart(3, "0")} urgent
              </span>
            )}
            {health.syncCount > 0 && (
              <span className="health-metric health-metric-sync">
                {String(health.syncCount).padStart(3, "0")} sync
              </span>
            )}
            {health.urgentCount === 0 && health.syncCount === 0 && (
              <span className="health-card-stats">{String(health.taskCount).padStart(3, "0")} tasks</span>
            )}
          </div>
          <div className="wip-mini-bar">
            {health.wipSegments.map((segment, idx) => (
              <div
                key={idx}
                className={cn("wip-mini-segment", `wip-mini-segment-${segment.state}`)}
                style={{ flex: segment.flex }}
              />
            ))}
          </div>
          <div className="health-card-footer">
            <div className="health-card-stats">
              {String(health.taskCount).padStart(3, "0")} tasks · {String(health.columnCount).padStart(3, "0")} cols
            </div>
          </div>
        </>
      )}
    </Link>
  );
}

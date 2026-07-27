import { Link } from "@tanstack/react-router";
import { cn } from "./ui/cn";
import type { Project } from "../../shared/types";

function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

interface ProjectCardProps {
  project: Project;
  className?: string;
}

export function ProjectCard({ project, className }: ProjectCardProps) {
  const stats = `/${project.slug}`;
  return (
    <Link to="/$slug" params={{ slug: project.slug }} className={cn("project-card", className)}>
      {project.githubRepo && (
        <div className="project-card-gh">
          <GithubMark />
        </div>
      )}
      <h2 className="project-card-name">{project.name}</h2>
      <p className="project-card-desc">{project.description}</p>
      <span className="project-card-stats">{stats}</span>
    </Link>
  );
}

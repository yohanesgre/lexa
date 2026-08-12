import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useProjects, useDashboard } from "../../lib/queries";
import { useProjectSelection } from "../../lib/project-selection";
import { ChevronIcon } from "./ChevronIcon";

type ProjectStatus = { health: "ok" | "approaching" | "exceeded"; taskCount: number };

export function ProjectSwitcher({ routeType }: { routeType: "home" | "dashboard" | "board" | "tasks" | "wiki" | "settings" | "forge" }) {
  const [open, setOpen] = useState(false);
  const { data: projects, isLoading } = useProjects();
  const { data: dashboard } = useDashboard();
  const { selectedSlug, selectedProjectName, setSelectedSlug } = useProjectSelection();
  const selectedProjectId = projects?.find((p) => p.slug === selectedSlug)?.id;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const triggerLabel = isLoading
    ? "Loading…"
    : selectedProjectName ?? (projects && projects.length === 0 ? "No projects" : "Select project");

  const targetFor = (slug: string) => {
    if (routeType === "board") return "/$slug/board" as const;
    if (routeType === "wiki") return "/$slug/wiki" as const;
    return "/$slug" as const;
  };

  const statusBySlug = new Map<string, ProjectStatus>();
  if (dashboard?.projects) {
    for (const entry of dashboard.projects) {
      statusBySlug.set(entry.project.slug, { health: entry.health, taskCount: entry.taskCount });
    }
  }

  return (
    <div ref={containerRef} className="project-switcher">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="nav-pill"
      >
        <span className="font-medium">{triggerLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="project-switcher-menu" role="menu" onClick={() => setOpen(false)}>
          <div className="dropdown-label">Projects</div>
          {!projects || isLoading ? (
            <div className="project-switcher-row">
              <span className="project-switcher-row-desc">Loading projects…</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="project-switcher-row">
              <span className="project-switcher-row-desc">No projects yet</span>
            </div>
          ) : (
            projects.map((project) => {
              const isCurrent = project.slug === selectedSlug;
              const status = statusBySlug.get(project.slug);
              const rowContent = (
                <>
                  <span className={status ? `health-dot health-dot-${status.health}` : "health-dot"} />
                  <div className="project-switcher-row-info">
                    <span className="project-switcher-row-name">{project.name}</span>
                    <span className="project-switcher-row-desc">{project.slug}</span>
                  </div>
                  <span className="project-switcher-row-count">
                    {status ? String(status.taskCount).padStart(3, "0") : ""}
                  </span>
                </>
              );
              return (
                <Link
                  key={project.id}
                  to={targetFor(project.slug)}
                  params={{ slug: project.slug }}
                  className={isCurrent ? "project-switcher-row active" : "project-switcher-row"}
                  onClick={() => setSelectedSlug(project.slug)}
                >
                  {rowContent}
                </Link>
              );
            })
          )}
          <div className="project-switcher-separator" />
          {selectedSlug && (
            <Link
              to="/settings/project/$projectId"
              params={{ projectId: selectedProjectId ?? "" }}
              className="project-switcher-row"
              activeProps={{ className: "project-switcher-row" }}
              onClick={() => setOpen(false)}
            >
              <span className="project-switcher-row-name">Project settings</span>
            </Link>
          )}
          <Link
            to="/"
            search={{ new: true } as never}
            className="project-switcher-row"
            activeProps={{ className: "project-switcher-row" }}
          >
            <span className="project-switcher-row-name">Create new project</span>
          </Link>
        </div>
      )}
    </div>
  );
}


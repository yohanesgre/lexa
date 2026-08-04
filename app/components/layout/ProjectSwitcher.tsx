import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useProjects } from "../../lib/queries";
import { useProjectSelection } from "../../lib/project-selection";
import { ChevronIcon } from "./ChevronIcon";

export function ProjectSwitcher({ routeType }: { routeType: "dashboard" | "board" | "wiki" | "settings" }) {
  const [open, setOpen] = useState(false);
  const { data: projects, isLoading } = useProjects();
  const { selectedSlug, selectedProjectName, setSelectedSlug } = useProjectSelection();
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
    if (routeType === "wiki") return "/$slug/wiki" as const;
    return "/$slug" as const;
  };

  return (
    <div ref={containerRef} className="project-switcher">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="project-switcher-trigger"
      >
        <span className="text-sm font-medium font-body text-lx-text-primary">{triggerLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="project-switcher-menu" role="menu" onClick={() => setOpen(false)}>
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
              return (
                <Link
                  key={project.id}
                  to={targetFor(project.slug)}
                  params={{ slug: project.slug }}
                  className={isCurrent ? "project-switcher-row active" : "project-switcher-row"}
                  onClick={() => setSelectedSlug(project.slug)}
                >
                  <div className="project-switcher-row-info">
                    <span className="project-switcher-row-name">{project.name}</span>
                    <span className="project-switcher-row-desc">{project.slug}</span>
                  </div>
                </Link>
              );
            })
          )}
          <div className="project-switcher-separator" />
          <Link to="/" className="project-switcher-row" activeProps={{ className: "project-switcher-row" }}>
            <span className="project-switcher-row-name">Create new project</span>
          </Link>
        </div>
      )}
    </div>
  );
}


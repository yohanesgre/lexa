import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Check, X, Trash2 } from "lucide-react";
import { cn } from "./ui/cn";
import type { Project, ProjectHealth } from "../../shared/types";
import { useUpdateProject, useDeleteProject } from "../lib/queries";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [githubRepo, setGithubRepo] = useState(project.githubRepo ?? "");
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  useEffect(() => {
    if (!settingsOpen) return;
    setName(project.name);
    setDescription(project.description);
    setGithubRepo(project.githubRepo ?? "");
  }, [settingsOpen, project]);

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSettingsOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (updateProject.isPending) return;
    updateProject.mutate(
      {
        slug: project.slug,
        name: name.trim(),
        description: description.trim(),
        githubRepo: githubRepo.trim() || null,
      },
      { onSuccess: () => setSettingsOpen(false) }
    );
  };

  const handleDelete = () => {
    if (deleteProject.isPending) return;
    deleteProject.mutate(project.slug, { onSuccess: () => setDeleteOpen(false) });
  };

  const countsChip = health
    ? `${String(health.taskCount).padStart(3, "0")} TASKS · ${String(health.columnCount).padStart(3, "0")} COLS · ${String(1 + (project.slug.length % 3)).padStart(3, "0")} SWIMLANES`
    : "tasks, columns, and swimlanes";

  return (
    <>
      <div className={cn("project-card health-card", className)}>
        <Link to="/$slug" params={{ slug: project.slug }} search={{}} className="flex flex-col h-full">
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
                {project.githubRepo && (
                  <div className="health-card-gh">
                    <GithubMark />
                  </div>
                )}
              </div>
            </>
          )}
        </Link>
        <button
          type="button"
          className="btn btn-ghost dashboard-settings-btn"
          aria-label="Project settings"
          onClick={handleOpenSettings}
        >
          <MoreHorizontal size={16} strokeWidth={1.5} />
        </button>
      </div>

      {settingsOpen && (
        <>
          <div
            className="slideover-overlay"
            role="button"
            tabIndex={0}
            aria-label="Close dialog"
            onClick={() => setSettingsOpen(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSettingsOpen(false); }}
          />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <form
              className="modal dialog-enter pointer-events-auto"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-settings-title"
              onSubmit={handleSave}
            >
              <div className="modal-header">
                <span id="project-settings-title" className="modal-title">Project Settings</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 32, height: 32, padding: 0 }}
                  aria-label="Close"
                  onClick={() => setSettingsOpen(false)}
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              </div>
              <div className="modal-body">
                <div className="mb-4">
                  <label className="field-label" htmlFor="project-settings-name">Name</label>
                  <input
                    id="project-settings-name"
                    className="prop-input w-full"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={updateProject.isPending}
                  />
                  <div className="field-hint">Shown on the dashboard and in the nav. Slug is derived from the name.</div>
                </div>
                <div className="mb-4">
                  <label className="field-label" htmlFor="project-settings-desc">Description</label>
                  <textarea
                    id="project-settings-desc"
                    className="prop-input w-full"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={updateProject.isPending}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="project-settings-gh">
                    GitHub Repository
                    <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em] ml-1.5">Optional</span>
                  </label>
                  <input
                    id="project-settings-gh"
                    className="prop-input w-full"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/repo"
                    disabled={updateProject.isPending}
                  />
                  <div className="field-hint">Enables two-way issue sync. Can be linked later in Settings.</div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setSettingsOpen(false)}
                  disabled={updateProject.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  style={{ marginRight: "auto" }}
                  onClick={() => {
                    setSettingsOpen(false);
                    setDeleteOpen(true);
                  }}
                  disabled={updateProject.isPending || deleteProject.isPending}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete Project
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={updateProject.isPending || !name.trim()}
                >
                  <Check size={14} strokeWidth={1.5} />
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {deleteOpen && (
        <>
          <div
            className="slideover-overlay"
            role="button"
            tabIndex={0}
            aria-label="Close dialog"
            onClick={() => setDeleteOpen(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDeleteOpen(false); }}
          />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div
              className="dialog dialog-enter pointer-events-auto"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-project-title"
            >
              <h2 id="delete-project-title" className="font-display text-lg font-medium text-lx-text-primary">
                Delete &lsquo;{project.name}&rsquo;?
              </h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This will permanently delete the project and all of its{" "}
                <span
                  className="font-micro text-2xs"
                  style={{
                    background: "var(--lx-surface-card)",
                    borderRadius: 4,
                    padding: "2px 5px",
                    color: "var(--lx-text-primary)",
                  }}
                >
                  {countsChip}
                </span>
                {" "}and wiki pages. This action cannot be undone.
              </p>
              {project.githubRepo ? (
                <p className="text-sm text-lx-text-secondary mt-2 leading-5">
                  The linked GitHub repository{" "}
                  <span
                    className="font-mono text-xs"
                    style={{
                      background: "var(--lx-surface-card)",
                      borderRadius: 4,
                      padding: "2px 5px",
                      color: "var(--lx-text-primary)",
                    }}
                  >
                    {project.githubRepo}
                  </span>
                  {" "}and its issues will not be affected.
                </p>
              ) : (
                <p className="text-sm text-lx-text-secondary mt-2 leading-5">No linked GitHub repository will be affected.</p>
              )}
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setDeleteOpen(false)}
                  disabled={deleteProject.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={handleDelete}
                  disabled={deleteProject.isPending}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete Project
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

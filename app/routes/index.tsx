import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutGrid, Plus, X } from "lucide-react";
import { useState } from "react";
import { useDashboard, useCreateProject } from "../lib/queries";
import { ProjectCard } from "../components/ProjectCard";
import { cn } from "../components/ui/cn";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function pad(n: number) {
  return String(n).padStart(3, "0");
}

function Dashboard() {
  const { data: dashboard, isLoading } = useDashboard();
  const createProject = useCreateProject();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [githubRepo, setGithubRepo] = useState("");

  const healthData = dashboard?.projects ?? [];
  const attentionTasks = dashboard?.urgentTasks ?? [];
  const attentionSyncs = dashboard?.outOfSyncTasks ?? [];

  if (isLoading) {
    return (
      <main className="page-frame">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-lx-text-primary">Command Center</h1>
            <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">Project health overview</div>
          </div>
        </div>
        <div className="project-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} className="project-card bg-lx-surface-card border border-lx-border-subtle rounded-md" style={{ padding: "10px 12px", minHeight: 200 }}>
              <div className="skeleton" style={{ width: i === 1 ? 56 : i === 2 ? 40 : 48, height: 18 }} />
              <div className="skeleton mt-2" style={{ width: i === 1 ? "85%" : i === 2 ? "92%" : "78%", height: 14 }} />
              <div className="skeleton mt-1" style={{ width: i === 1 ? "60%" : i === 2 ? "45%" : "66%", height: 14 }} />
              <div className="flex items-center gap-2" style={{ marginTop: "auto", paddingTop: 16 }}>
                <div className="skeleton skeleton-circle" style={{ width: 20, height: 20 }} />
                <div className="skeleton" style={{ width: i === 1 ? 72 : i === 2 ? 56 : 64, height: 12 }} />
              </div>
            </div>
          ))}
        </div>
      </main>
    );
  }

  const isEmpty = !healthData.length;

  const stats = dashboard?.stats ?? { totalTasks: 0, activeProjects: 0, wipExceeded: 0, outOfSync: 0 };

  return (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-lx-text-primary">
            {isEmpty ? "Projects" : "Command Center"}
          </h1>
          {!isEmpty && (
            <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">
              Project health overview
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={1.5} />
            New Project
          </button>
        </div>
      </div>

      {createProject.error && <div className="dashboard-error">{(createProject.error as Error).message}</div>}

      {showCreate && (
        <>
          <div
            className="slideover-overlay"
            role="button"
            tabIndex={0}
            aria-label="Close dialog"
            onClick={() => setShowCreate(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setShowCreate(false); }}
          />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div
              className="modal dialog-enter pointer-events-auto"
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-project-title"
              style={{ maxWidth: 440 }}
            >
              <div className="modal-header">
                <span id="create-project-title" className="modal-title">New Project</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: 32, height: 32, padding: 0 }}
                  aria-label="Close"
                  onClick={() => setShowCreate(false)}
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              </div>
              <div className="modal-body">
                <div className="field" style={{ marginBottom: 16 }}>
                  <label className="field-label" htmlFor="create-project-name">Name</label>
                  <input
                    id="create-project-name"
                    className="prop-input w-full"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                    placeholder=""
                    disabled={createProject.isPending}
                  />
                  <div className="field-hint">Shown on the dashboard and in the nav. Slug is derived from the name.</div>
                </div>
                <div className="field" style={{ marginBottom: 16 }}>
                  <label className="field-label" htmlFor="create-project-desc">Description</label>
                  <textarea
                    id="create-project-desc"
                    className="prop-input w-full"
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={3}
                    disabled={createProject.isPending}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="create-project-gh">
                    GitHub Repository
                    <span
                      className="font-micro text-2xs text-lx-text-muted"
                      style={{ textTransform: "uppercase", letterSpacing: "0.04em", marginLeft: 6 }}
                    >
                      Optional
                    </span>
                  </label>
                  <input
                    id="create-project-gh"
                    className="prop-input w-full"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/name"
                    disabled={createProject.isPending}
                  />
                  <div className="field-hint">Enables two-way issue sync. Can be linked later in Settings.</div>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowCreate(false)}
                  disabled={createProject.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={createProject.isPending || !name.trim()}
                  onClick={() => {
                    createProject.mutate(
                      {
                        name: name.trim(),
                        description: desc.trim() || undefined,
                        githubRepo: githubRepo.trim() || undefined,
                      },
                      {
                        onSuccess: () => {
                          setName("");
                          setDesc("");
                          setGithubRepo("");
                          setShowCreate(false);
                        },
                      }
                    );
                  }}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  Create Project
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {isEmpty ? (
        <div className="bg-lx-surface-column border border-lx-border-subtle rounded-lg mt-4 flex" style={{ minHeight: 480 }}>
          <div className="empty-state flex-1">
            <div className="empty-state-icon">
              <LayoutGrid size={24} strokeWidth={1.5} />
            </div>
            <h2 className="font-display text-lg font-medium text-lx-text-primary mt-3">No projects yet</h2>
            <p className="text-sm text-lx-text-secondary mt-1" style={{ maxWidth: 300 }}>
              Create your first project to start tracking tasks, columns, and wiki pages — with optional two-way GitHub sync.
            </p>
            <button type="button" className="btn btn-primary mt-4" onClick={() => setShowCreate(true)}>
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="project-grid">
            {healthData.map((h) => (
              <ProjectCard key={h.project.id} project={h.project} health={h} />
            ))}
          </div>

          <div className="stats-bar mt-4">
            <div className="stat-card">
              <div className="stat-label">Total tasks</div>
              <div className="stat-value">{pad(stats.totalTasks)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Active projects</div>
              <div className="stat-value">{pad(stats.activeProjects)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">WIP exceeded</div>
              <div className={cn("stat-value", stats.wipExceeded > 0 && "stat-value-danger")}>{pad(stats.wipExceeded)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Out-of-sync tasks</div>
              <div className={cn("stat-value", stats.outOfSync > 0 && "stat-value-warning")}>{pad(stats.outOfSync)}</div>
            </div>
          </div>

          {(attentionTasks.length > 0 || attentionSyncs.length > 0) && (
            <div className="attention-section">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-xl font-semibold text-lx-text-primary">Needs Attention</h2>
              </div>
              <div className="attention-grid">
                {attentionTasks.length > 0 && (
                  <div className="attention-card">
                    <div className="attention-title">Urgent tasks</div>
                    {attentionTasks.map((task) => (
                      <Link
                        key={task.id}
                        to="/$slug"
                        params={{ slug: task.projectSlug }}
                        search={{ task: task.id }}
                        className="attention-item"
                      >
                        <span className="attention-dot attention-dot-exceeded" />
                        <div className="attention-meta">
                          <div className="attention-task-title">{task.title}</div>
                          <div className="attention-task-context">
                            {task.projectName} · {task.columnName}
                          </div>
                        </div>
                        <div className="attention-task-id">#{task.id}</div>
                      </Link>
                    ))}
                  </div>
                )}
                {attentionSyncs.length > 0 && (
                  <div className="attention-card">
                    <div className="attention-title">Out-of-sync GitHub issues</div>
                    {attentionSyncs.map((sync) => (
                      <Link
                        key={sync.id}
                        to="/$slug"
                        params={{ slug: sync.projectSlug }}
                        search={{ task: sync.id }}
                        className="attention-item"
                      >
                        <span className="attention-dot attention-dot-approaching" />
                        <div className="attention-meta">
                          <div className="attention-task-title">{sync.title}</div>
                          <div className="attention-task-context">
                            {sync.projectName} · {sync.repo}#{sync.issueNumber}
                          </div>
                        </div>
                        <div className="attention-task-id">#{sync.id}</div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

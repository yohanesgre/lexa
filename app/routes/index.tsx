import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutGrid, Plus, TrendingUp } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { useProjects, useCreateProject } from "../lib/queries";
import {
  stubProjectHealth,
  stubAttentionTasks,
  stubAttentionSyncs,
  type ProjectHealth,
} from "../lib/dashboard-stubs";
import { ProjectCard } from "../components/ProjectCard";
import { cn } from "../components/ui/cn";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function pad(n: number) {
  return String(n).padStart(3, "0");
}

function Dashboard() {
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);

  const healthData = useMemo(() => (projects ? stubProjectHealth(projects) : []), [projects]);
  const attentionTasks = useMemo(() => (projects ? stubAttentionTasks(projects) : []), [projects]);
  const attentionSyncs = useMemo(() => (projects ? stubAttentionSyncs(projects) : []), [projects]);

  const healthBySlug = useMemo(() => {
    const map = new Map<string, ProjectHealth>();
    for (const h of healthData) map.set(h.project.slug, h);
    return map;
  }, [healthData]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setConfirming(true);
  };

  if (isLoading) {
    return (
      <main className="page-frame">
        <div className="dashboard-loading">Loading projects…</div>
      </main>
    );
  }

  const totalTasks = healthData.reduce((sum, h) => sum + h.taskCount, 0);
  const wipExceeded = healthData.filter((h) => h.health === "exceeded").length;
  const outOfSync = healthData.reduce((sum, h) => sum + h.syncCount, 0);

  const isEmpty = !projects || projects.length === 0;

  return (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-lx-text-primary">Command Center</h1>
          <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">
            Project health overview
          </div>
        </div>
        <div className="flex items-center gap-3">
          <form onSubmit={handleCreate} className="flex items-center gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project name"
              className="prop-input"
              disabled={createProject.isPending}
            />
            <button type="submit" disabled={createProject.isPending || !name.trim()} className="btn btn-primary">
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </form>
        </div>
      </div>

      {createProject.error && <div className="dashboard-error">{(createProject.error as Error).message}</div>}

      {confirming && (
        <>
          <div className="slideover-overlay" onClick={() => setConfirming(false)} />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true" style={{ maxWidth: 400 }}>
              <h2 className="font-display text-lg font-medium text-lx-text-primary">Create project?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                Create{" "}
                <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
                  {name.trim()}
                </span>
                ? It will be set up with 5 default columns (Todo, In Progress, Review, Done, Blocked).
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={() => {
                  createProject.mutate({ name: name.trim() }, {
                    onSettled: () => { setName(""); setConfirming(false); },
                  });
                }}>
                  <Plus size={14} strokeWidth={1.5} />
                  Create
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
            <button
              type="button"
              className="btn btn-primary mt-4"
              onClick={() => document.querySelector<HTMLInputElement>('input[placeholder="New project name"]')?.focus()}
            >
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="project-grid">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} health={healthBySlug.get(p.slug)} />
            ))}
          </div>

          <div className="stats-bar mt-4">
            <div className="stat-card">
              <div className="stat-label">Total tasks</div>
              <div className="stat-value">{pad(totalTasks)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Active projects</div>
              <div className="stat-value">{pad(projects.length)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">WIP exceeded</div>
              <div className={cn("stat-value", wipExceeded > 0 && "stat-value-danger")}>{pad(wipExceeded)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Out-of-sync tasks</div>
              <div className={cn("stat-value", outOfSync > 0 && "stat-value-warning")}>{pad(outOfSync)}</div>
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
                        <div className="attention-task-id">{task.taskNumber}</div>
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
                        <div className="attention-task-id">{sync.taskNumber}</div>
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

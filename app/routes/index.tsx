import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useDashboard, useCreateProject, useUpdateProject, useDeleteProject, useBoard, selectProjectHealth } from "../lib/queries";
import { getSetupStatus } from "../lib/api";
import { cn } from "../components/ui/cn";
import { CreateProjectModal } from "../components/CreateProjectModal";
import { ProjectSettingsModal } from "../components/ProjectSettingsModal";
import { useProjectSelection } from "../lib/project-selection";
import type { Dashboard, ProjectHealth } from "../../shared/types";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === "1" || search.new === true ? true : undefined,
  }),
  component: Dashboard,
});

function pad(n: number) {
  return String(n).padStart(3, "0");
}

type ColumnState = "ok" | "approaching" | "exceeded" | "empty";

// Mirrors DashboardService.getDashboard column state derivation exactly.
function columnState(count: number, wipLimit: number | null): ColumnState {
  if (count === 0) return "empty";
  if (wipLimit !== null && count > wipLimit) return "exceeded";
  if (wipLimit !== null && count >= wipLimit) return "approaching";
  return "ok";
}

function Dashboard() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { data: dashboard, isLoading } = useDashboard();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const { selectedSlug } = useProjectSelection();
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    getSetupStatus()
      .then((s) => {
        if (s.needsAdmin && !s.hasProjects && !s.hasApiKey) {
          navigate({ to: "/setup" });
        } else if (s.needsAdmin) {
          setNeedsSetup(true);
        }
      })
      .catch(() => {});
  }, [navigate]);

  // Switcher "Create new project" lands on /?new=1 — open the modal and clear
  // the param so the URL stays clean.
  useEffect(() => {
    if (!search.new) return;
    setShowCreate(true);
    navigate({ to: "/", search: {} });
  }, [search.new, navigate]);

  if (isLoading) {
    return (
      <main className="page-frame">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="skeleton" style={{ width: 160, height: 24 }} />
            <div className="skeleton mt-2" style={{ width: 96, height: 12 }} />
          </div>
          <div className="flex items-center gap-3">
            <div className="skeleton" style={{ width: 32, height: 32 }} />
            <div className="skeleton" style={{ width: 120, height: 32 }} />
          </div>
        </div>
        <div className="stats-bar" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="stat-card">
              <div className="skeleton" style={{ width: 72, height: 12 }} />
              <div className="skeleton mt-2" style={{ width: 48, height: 22 }} />
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 40 }} />
          ))}
        </div>
      </main>
    );
  }

  const health = selectProjectHealth(dashboard, selectedSlug);
  const isEmpty = !health;

  return (
    <main className="page-frame">
      {isEmpty ? (
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-lx-text-primary">Projects</h1>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span
              className={cn("health-dot", `health-dot-${health.health}`)}
              title={`WIP ${health.health}`}
            />
            <div>
              <h1 className="font-display text-2xl font-semibold text-lx-text-primary">{health.project.name}</h1>
              <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">Project status</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 28, height: 28, padding: 0 }}
              aria-label="Project settings"
              title="Project settings"
              onClick={() => setShowSettings(true)}
            >
              <MoreHorizontal size={16} strokeWidth={1.5} />
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </div>
        </div>
      )}

      {needsSetup && (
        <div className="flex items-center justify-between bg-lx-surface-elevated border border-lx-border-warning rounded-md px-4 py-2.5 mb-4">
          <div className="text-sm text-lx-text-secondary">
            <span className="font-medium text-lx-text-primary">Setup incomplete</span> — no admin email is configured.
          </div>
          <Link to="/setup" className="btn btn-ghost !h-7 !px-3 text-xs">
            Finish setup
          </Link>
        </div>
      )}

      {createProject.error && <div className="dashboard-error">{(createProject.error as Error).message}</div>}

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
        <StatusSections dashboard={dashboard!} health={health} />
      )}

      <CreateProjectModal
        open={showCreate}
        pending={createProject.isPending}
        onClose={() => setShowCreate(false)}
        onSubmit={(input) => {
          createProject.mutate(input, {
            onSuccess: () => setShowCreate(false),
          });
        }}
      />

      {!isEmpty && (
        <ProjectSettingsModal
          open={showSettings}
          project={health.project}
          pending={updateProject.isPending || deleteProject.isPending}
          onClose={() => setShowSettings(false)}
          onSave={(input) => {
            updateProject.mutate(
              { slug: health.project.slug, ...input, githubRepo: input.githubRepo || null },
              { onSuccess: () => setShowSettings(false) }
            );
          }}
          onDelete={() => {
            setShowSettings(false);
            deleteProject.mutate(health.project.slug, {
              onSuccess: () => navigate({ to: "/" }),
            });
          }}
        />
      )}
    </main>
  );
}

function StatusSections({ dashboard, health }: { dashboard: Dashboard; health: ProjectHealth }) {
  const slug = health.project.slug;
  const board = useBoard(slug);

  const columns = (board.data?.columns ?? []).map((c) => {
    const count = (board.data?.tasks ?? []).filter((t) => t.columnId === c.id).length;
    const state = columnState(count, c.wipLimit);
    const fillPct = c.wipLimit ? Math.min(100, (count / c.wipLimit) * 100) : count > 0 ? 100 : 0;
    return { id: c.id, name: c.name, wipLimit: c.wipLimit, count, state, fillPct };
  });

  const wipExceeded = health.wipSegments.filter((s) => s.state === "exceeded").length;
  const urgentTasks = dashboard.urgentTasks.filter((t) => t.projectSlug === slug);
  const outOfSyncTasks = dashboard.outOfSyncTasks.filter((t) => t.projectSlug === slug);

  return (
    <>
      <div className="stats-bar" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="stat-card">
          <div className="stat-label">Total tasks</div>
          <div className="stat-value">{pad(health.taskCount)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">WIP exceeded</div>
          <div className={cn("stat-value", wipExceeded > 0 && "stat-value-danger")}>{pad(wipExceeded)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Out-of-sync</div>
          <div className={cn("stat-value", health.syncCount > 0 && "stat-value-warning")}>{pad(health.syncCount)}</div>
        </div>
      </div>

      <div className="attention-section">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xl font-semibold text-lx-text-primary">Column WIP</h2>
        </div>
        {columns.map((c) => (
          <Link key={c.id} to="/$slug" params={{ slug }} search={{}} className="status-column-row">
            <span className="status-column-name">{c.name}</span>
            <span className="status-column-count">
              {c.count} / {c.wipLimit ?? "∞"}
            </span>
            <div className="status-bar">
              <div className={cn("status-bar-fill", `status-bar-${c.state}`)} style={{ width: `${c.fillPct}%` }} />
            </div>
            <span className={cn("status-badge", `status-badge-${c.state}`)}>{c.state}</span>
          </Link>
        ))}
      </div>

      {(urgentTasks.length > 0 || outOfSyncTasks.length > 0) && (
        <div className="attention-section">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-xl font-semibold text-lx-text-primary">Needs Attention</h2>
          </div>
          <div className="attention-grid">
            {urgentTasks.length > 0 && (
              <div className="attention-card">
                <div className="attention-title">Urgent tasks</div>
                {urgentTasks.map((task) => (
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
                      <div className="attention-task-context">{task.columnName}</div>
                    </div>
                    <div className="attention-task-id">#{task.id}</div>
                  </Link>
                ))}
              </div>
            )}
            {outOfSyncTasks.length > 0 && (
              <div className="attention-card">
                <div className="attention-title">Out-of-sync GitHub issues</div>
                {outOfSyncTasks.map((sync) => (
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
                        {sync.repo}#{sync.issueNumber}
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
  );
}

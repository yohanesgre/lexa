import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useDashboard, useUpdateProject, useDeleteProject, useBoard, selectProjectHealth } from "../../lib/queries";
import { cn } from "../../components/ui/cn";
import { ProjectSettingsModal } from "../../components/ProjectSettingsModal";
import { ProjectDescription } from "../../components/ProjectDescription";
import type { Dashboard, ProjectHealth } from "../../../shared/types";

export const Route = createFileRoute("/$slug/")({
  component: ProjectDashboard,
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

function ProjectDashboard() {
  const navigate = useNavigate();
  const { slug } = Route.useParams();
  const { data: dashboard, isLoading } = useDashboard();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const board = useBoard(slug);
  const [showSettings, setShowSettings] = useState(false);

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
  if (board.isError) {
    return <div className="board-error">Failed to load board: {(board.error as Error).message}</div>;
  }
  if (!board.data) return <div className="board-error">Project not found</div>;

  // Project without a dashboard entry renders with zeroed stats — never the
  // homepage empty state.
  const health: ProjectHealth = selectProjectHealth(dashboard, slug) ?? {
    project: board.data.project,
    taskCount: 0,
    columnCount: 0,
    urgentCount: 0,
    syncCount: 0,
    health: "ok",
    wipSegments: [],
  };

  return (
    <main className="page-frame">
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
        </div>
      </div>

      <ProjectDescription description={health.project.description || board.data.project?.description || ""} />

      <StatusSections dashboard={dashboard} health={health} />

      <ProjectSettingsModal
        open={showSettings}
        project={health.project}
        pending={updateProject.isPending || deleteProject.isPending}
        onClose={() => setShowSettings(false)}
        onSave={(input) => {
          updateProject.mutate(
            { slug: health.project.slug, ...input },
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
    </main>
  );
}

function StatusSections({ dashboard, health }: { dashboard: Dashboard | undefined; health: ProjectHealth }) {
  const slug = health.project.slug;
  const board = useBoard(slug);

  const columns = (board.data?.columns ?? []).map((c) => {
    const count = (board.data?.tasks ?? []).filter((t) => t.columnId === c.id).length;
    const state = columnState(count, c.wipLimit);
    const fillPct = c.wipLimit ? Math.min(100, (count / c.wipLimit) * 100) : count > 0 ? 100 : 0;
    return { id: c.id, name: c.name, wipLimit: c.wipLimit, count, state, fillPct };
  });

  const wipExceeded = health.wipSegments.filter((s) => s.state === "exceeded").length;
  const urgentTasks = dashboard?.urgentTasks.filter((t) => t.projectSlug === slug) ?? [];
  const outOfSyncTasks = dashboard?.outOfSyncTasks.filter((t) => t.projectSlug === slug) ?? [];

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
          <Link key={c.id} to="/$slug/board" params={{ slug }} search={{}} className="status-column-row">
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
                    to="/$slug/board"
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
                    to="/$slug/board"
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

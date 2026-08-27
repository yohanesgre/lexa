import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useDashboard, useCreateProject } from "../lib/queries";
import { getSetupStatus, getDashboard } from "../lib/api";
import { CreateProjectModal } from "../components/CreateProjectModal";
import { useProjectSelection } from "../lib/project-selection";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { new?: boolean | undefined } => ({
    new: search.new === "1" || search.new === true ? true : undefined,
  }),
  loader: async ({ context }) => {
    // Prefetch the dashboard so the first paint renders content instead of
    // skeletons — the same key/queryFn the component's useDashboard reads.
    await context.queryClient.prefetchQuery({
      queryKey: ["dashboard"],
      queryFn: () => getDashboard(),
    });
  },
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { data: dashboard, isLoading } = useDashboard();
  const createProject = useCreateProject();
  const { setSelectedSlug } = useProjectSelection();
  const [showCreate, setShowCreate] = useState(false);
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

  const isEmpty = !dashboard?.projects.length;

  return (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-2xl font-semibold text-lx-text-primary">Projects</h1>
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={1.5} />
            New Project
          </button>
        </div>
      </div>

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
        <div className="project-cards mt-2">
          {dashboard?.projects.map((entry) => (
            <Link
              key={entry.project.id}
              to="/$slug"
              params={{ slug: entry.project.slug }}
              className="project-card"
              onClick={() => setSelectedSlug(entry.project.slug)}
            >
              <span className="project-card-name">
                <span className={`health-dot health-dot-${entry.health}`} />
                {entry.project.name}
              </span>
              {entry.project.description ? (
                <span className="project-card-desc">{entry.project.description}</span>
              ) : null}
            </Link>
          ))}
        </div>
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
    </main>
  );
}
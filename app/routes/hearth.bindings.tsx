import { createFileRoute, Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useToast } from "../components/ui/Toast";
import { useProjects } from "../lib/queries";

export const Route = createFileRoute("/hearth/bindings")({
  validateSearch: (search: Record<string, unknown>): { projectId?: string | undefined } => ({
    projectId: typeof search.projectId === "string" && search.projectId ? search.projectId : undefined,
  }),
  ssr: false,
  component: HearthBindingsRoute,
});

function HearthBindingsRoute() {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) as string;
  const isDetail = pathname !== "/hearth/bindings" && pathname !== "/hearth/bindings/" && pathname.startsWith("/hearth/bindings/");
  const { canViewBindings, teamsLoading, sessionLoading, teams, isSuperadmin } = useHearthRole();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: projects = [], isLoading: projectsLoading } = useProjects();

  const visibleProjects = useMemo(() => {
    if (isSuperadmin) return projects;
    if (!teams || teams.length === 0) return projects;
    const teamIds = new Set(teams.map((t) => t.id));
    const filtered = projects.filter((p) => {
      const tid = (p as unknown as { teamId?: string | null }).teamId ?? null;
      return !!tid && teamIds.has(tid);
    });
    return filtered.length > 0 ? filtered : projects;
  }, [projects, teams, isSuperadmin]);

  useEffect(() => {
    if (!teamsLoading && !sessionLoading && !canViewBindings) {
      toast.push("warning", "You don't have access");
    }
  }, [teamsLoading, sessionLoading, canViewBindings, toast]);

  if (teamsLoading || sessionLoading) return <div className="card-panel mt-4"><span className="text-sm color-muted">Loading…</span></div>;
  if (!canViewBindings) {
    return <Navigate to="/hearth/runs" replace />;
  }

  if (isDetail) {
    return <Outlet />;
  }

  return (
    <>
      <section className="mt-4">
        <div className="card-panel card-panel--elevated">
          <label htmlFor="hearth-project-select" className="field-label">Project</label>
          <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
            {projectsLoading ? (
              <span className="text-sm color-muted">Loading projects…</span>
            ) : visibleProjects.length === 0 ? (
              <span className="text-sm color-muted">No projects in your team yet</span>
            ) : (
              <select
                id="hearth-project-select"
                aria-label="Select project"
                className="prop-input"
                style={{ minWidth: 280, maxWidth: 400 }}
                defaultValue=""
                onChange={(e) => {
                  const pid = e.target.value;
                  if (pid) void navigate({ to: "/hearth/bindings/$projectId", params: { projectId: pid } });
                }}
              >
                <option value="" disabled>— Select project —</option>
                {visibleProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.slug}</option>
                ))}
              </select>
            )}
            <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>{isSuperadmin ? "superadmin: all projects" : "team admin: own projects only"}</span>
          </div>
          <div className="field-hint">Picker sources GET /api/projects via session cookie — superadmin lists all, team admin lists scoped by teamIds (fallback shows all when filter empty).</div>
        </div>
        <div className="card-panel mt-4">
          <p className="text-sm color-secondary">Select a project above to manage its Herald bindings (provider, engine, write tools, memory).</p>
        </div>
      </section>
      <Outlet />
    </>
  );
}

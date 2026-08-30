import { createFileRoute, Navigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useProjects } from "../lib/queries";
import { useToast } from "../components/ui/Toast";
import { HeraldProjectProviderSection } from "../components/settings/herald-project";
import { HeraldEngineSection, HeraldWriteToolsSection, ProjectMemorySection, AgentSkillAvailabilitySection } from "../components/settings/HeraldSettingsSection";

export const Route = createFileRoute("/hearth/bindings/$projectId")({
  ssr:false,
  component: HearthBindingDetailRoute,
});

function HearthBindingDetailRoute() {
  const { projectId } = Route.useParams();
  const { canViewBindings, teamsLoading, sessionLoading, teams, isSuperadmin } = useHearthRole();
  const toast = useToast();
  const { data: projects, isLoading: projectsLoading } = useProjects();

  const project = useMemo(() => {
    if (!projects) return undefined;
    return projects.find((p) => p.id === projectId || p.slug === projectId);
  }, [projects, projectId]);

  const hasAccess = useMemo(() => {
    if (!canViewBindings) return false;
    if (isSuperadmin) return true;
    if (!project) return false;
    if (!teams || teams.length === 0) return true;
    const teamIds = new Set(teams.map((t) => t.id));
    const tid = (project as unknown as { teamId?: string | null }).teamId ?? null;
    if (!tid) return true;
    return teamIds.has(tid);
  }, [canViewBindings, isSuperadmin, project, teams]);

  useEffect(() => {
    if (!teamsLoading && !sessionLoading && !canViewBindings) {
      toast.push("warning", "You don't have access");
    }
  }, [teamsLoading, sessionLoading, canViewBindings, toast]);

  useEffect(() => {
    if (!teamsLoading && !sessionLoading && !projectsLoading && projects && projectId) {
      if (!project) {
        toast.push("warning", "Project not found or not in your team");
      } else if (!hasAccess) {
        toast.push("warning", "You don't have access to this project");
      }
    }
  }, [teamsLoading, sessionLoading, projectsLoading, projects, projectId, project, hasAccess, toast]);

  if (teamsLoading || sessionLoading || projectsLoading) {
    return (
      <section className="mt-4">
        <div className="card-panel card-panel--elevated skeleton" style={{ height: 120 }} />
        <p className="text-sm color-muted mt-3">Loading binding…</p>
      </section>
    );
  }
  if (!canViewBindings) {
    return <Navigate to="/hearth/runs" replace />;
  }
  if (!project || !hasAccess) {
    return <Navigate to="/hearth/runs" replace />;
  }

  return (
    <section className="mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Link to="/hearth/bindings" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }}>← Back to bindings</Link>
        <span className="font-mono text-xs color-muted">{project.slug} · {project.name}</span>
      </div>
      <HeraldProjectProviderSection project={project} />
      <HeraldEngineSection project={project} />
      <HeraldWriteToolsSection project={project} />
      <AgentSkillAvailabilitySection projectId={project.id} />
      <ProjectMemorySection projectId={project.id} />
    </section>
  );
}

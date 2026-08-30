import { createFileRoute, Navigate, useParams } from "@tanstack/react-router";
import { useProjects } from "../../lib/queries";

// Legacy project settings URL → the settings hub keyed by project id.
function ProjectSettingsRedirect() {
  const { slug } = useParams({ from: "/$slug/settings" });
  const { data: projects, isLoading } = useProjects();

  if (isLoading) return null;
  const project = projects?.find((p) => p.slug === slug);
  if (!project) return <Navigate to="/" replace />;
  return <Navigate to="/settings/project/$projectId" params={{ projectId: project.id }} replace />;
}

export const Route = createFileRoute("/$slug/settings")({
  ssr:false,
  component: ProjectSettingsRedirect,
});

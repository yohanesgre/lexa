import { createFileRoute, useParams } from "@tanstack/react-router";
import { ProjectSettingsHub } from "../../components/settings/ProjectSettingsHub";

// Project settings surface (project switcher → "Project settings"). Team
// assignment control lives here; project-bound sections (name/desc, repos,
// members, delete) are page-level equivalents of the dashboard modals.
export const Route = createFileRoute("/settings/project/$projectId")({
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const { projectId } = useParams({ from: "/settings/project/$projectId" });
  return <ProjectSettingsHub projectId={projectId} />;
}

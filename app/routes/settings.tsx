import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../components/settings/SettingsPage";
import { useProjectSelection } from "../lib/project-selection";

function RouteComponent() {
  const { selectedSlug } = useProjectSelection();
  return <SettingsPage slug={selectedSlug} />;
}

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
});

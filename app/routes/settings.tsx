import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SettingsPage } from "../components/settings/SettingsPage";
import { useProjectSelection } from "../lib/project-selection";
import { clientLxkUser } from "../lib/api";

function RouteComponent() {
  const { selectedSlug } = useProjectSelection();
  // Admin-only page: redirect known members away (null user = dev / Access-less
  // = allowed; the server enforces with 403 on member keys regardless).
  if (clientLxkUser()?.role === "member") {
    return <Navigate to="/" replace />;
  }
  return <SettingsPage slug={selectedSlug} />;
}

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
});

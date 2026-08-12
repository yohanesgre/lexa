import { createFileRoute, Navigate } from "@tanstack/react-router";
import { WorkspaceSettings } from "../../components/settings/WorkspaceSettings";
import { useSession, useTeams } from "../../lib/queries";

// Superadmin-only. The server enforces on every endpoint; direct hits from a
// known non-superadmin redirect to their own surface (the /settings landing
// logic) — the workspace page itself never renders for them.
function WorkspaceRoute() {
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();

  if (isLoading) return null;
  if (session?.user && session.user.role !== "superadmin") {
    const isTeamAdmin = teams && teams.length > 0;
    return <Navigate to={isTeamAdmin ? "/settings/team" : "/settings/me"} replace />;
  }
  return <WorkspaceSettings />;
}

export const Route = createFileRoute("/settings/workspace")({
  component: WorkspaceRoute,
});

import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useSession, useTeams } from "../lib/queries";

// /settings → role-redirect landing. Never rendered to a signed-in user.
// superadmin → /settings/workspace · team admin → /settings/team ·
// member → /settings/me. No session → /login (root guard).
function SettingsRedirect() {
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();

  if (isLoading) return null;
  if (!session?.user) return <Navigate to="/login" replace />;

  const isSuperadmin = session.user.role === "superadmin";
  const isTeamAdmin = isSuperadmin || (teams && teams.length > 0);

  if (isSuperadmin) return <Navigate to="/settings/workspace" replace />;
  if (isTeamAdmin) return <Navigate to="/settings/team" replace />;
  return <Navigate to="/settings/me" replace />;
}

export const Route = createFileRoute("/settings")({
  component: SettingsRedirect,
});

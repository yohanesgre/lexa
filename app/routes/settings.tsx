import { createFileRoute, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useSession, useTeams } from "../lib/queries";

// /settings is a layout for all settings pages. The BARE /settings path is a
// role-redirect landing: superadmin → /settings/workspace · team admin →
// /settings/team · member → /settings/me. Children (workspace/team/me) render
// through <Outlet/> — never redirect them.
function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) as string;
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();

  if (isLoading) return null;
  if (!session?.user) return <Navigate to="/login" replace />;

  if (pathname !== "/settings") return <Outlet />;

  const isSuperadmin = session.user.role === "superadmin";
  const isTeamAdmin = isSuperadmin || (teams && teams.length > 0);

  if (isSuperadmin) return <Navigate to="/settings/workspace" replace />;
  if (isTeamAdmin) return <Navigate to="/settings/team" replace />;
  return <Navigate to="/settings/me" replace />;
}

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

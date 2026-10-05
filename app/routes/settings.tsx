import { createFileRoute, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useSession, useTeams } from "../lib/queries";
import { settingsLandingPath } from "../lib/settings-landing";

// /settings is a layout for all settings pages. Children (workspace/team/me)
// render through <Outlet/> — never redirect them.
function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) as string;
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();

  if (isLoading) return null;
  if (!session?.user) return <Navigate to="/login" replace />;

  if (pathname !== "/settings") return <Outlet />;

  return <Navigate to={settingsLandingPath(session.user, teams)} replace />;
}

export const Route = createFileRoute("/settings")({
  ssr:false,
  component: SettingsLayout,
});

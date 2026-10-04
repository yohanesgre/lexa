import { createFileRoute, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useSession, useTeams } from "../lib/queries";

// Role-redirect landing target for the BARE /settings path: superadmin →
// /settings/workspace · team admin → /settings/team · member → /settings/me.
//
// GET /api/teams returns the teams the caller ADMINISTERS (owner/admin) for
// session users — plain members get an empty list (and superadmins get all
// teams, caught by the role branch first). Any team row therefore means
// team-admin authority; UserMenu derives its role the same way.
export function settingsLandingPath(
  user: { role: string } | null | undefined,
  teams: unknown[] | undefined
): "/settings/workspace" | "/settings/team" | "/settings/me" {
  if (user?.role === "superadmin") return "/settings/workspace";
  if (teams && teams.length > 0) return "/settings/team";
  return "/settings/me";
}

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

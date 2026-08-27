import { useSession, useTeams } from "./queries";

export function useHearthRole() {
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: teams, isLoading: teamsLoading } = useTeams();

  const role = session?.user?.role as string | undefined;
  const isSuperadmin = role === "superadmin" || role === "admin";
  const isTeamAdmin = isSuperadmin || (teams !== undefined && teams !== null && teams.length > 0);
  const canViewRuntimes = isSuperadmin || !!isTeamAdmin;
  const canViewBindings = isSuperadmin || !!isTeamAdmin;
  const isLoading = sessionLoading || teamsLoading;

  return {
    session,
    teams,
    isLoading,
    teamsLoading,
    sessionLoading,
    isSuperadmin: !!isSuperadmin,
    isTeamAdmin: !!isTeamAdmin,
    canViewRuntimes,
    canViewBindings,
    canViewUsage: !!isSuperadmin,
    canViewProviders: !!isSuperadmin,
    canViewAgents: !!isSuperadmin,
  };
}

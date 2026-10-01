import { createFileRoute, Navigate } from "@tanstack/react-router";
import { WorkspaceSettings, type WorkspaceTab } from "../../components/settings/WorkspaceSettings";
import type { GithubReturnResult } from "../../components/settings/SettingsSections";
import { useSession, useTeams } from "../../lib/queries";

const WORKSPACE_TABS: WorkspaceTab[] = ["members", "teams", "access", "integrations"];

// Superadmin-only. The server enforces on every endpoint; direct hits from a
// known non-superadmin redirect to their own surface (the /settings landing
// logic) — the workspace page itself never renders for them.
function WorkspaceRoute() {
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();
  // The GitHub callback returns here with its result: ?tab=integrations and
  // ?github=connected | ?github=failed&reason=… .
  const { tab, github, reason } = Route.useSearch();

  if (isLoading) return null;
  if (session?.user && session.user.role !== "superadmin") {
    const isTeamAdmin = teams && teams.length > 0;
    return <Navigate to={isTeamAdmin ? "/settings/team" : "/settings/me"} replace />;
  }

  const initialTab = WORKSPACE_TABS.find((t) => t === tab);
  const githubResult: GithubReturnResult | undefined =
    github === "connected" ? { status: "connected" } : github === "failed" ? { status: "failed", reason } : undefined;

  return <WorkspaceSettings initialTab={initialTab} githubResult={githubResult} />;
}

export const Route = createFileRoute("/settings/workspace")({
  validateSearch: (search: Record<string, unknown>): { tab?: string | undefined; github?: string | undefined; reason?: string | undefined } => ({
    tab: typeof search.tab === "string" && search.tab ? search.tab : undefined,
    github: typeof search.github === "string" && search.github ? search.github : undefined,
    reason: typeof search.reason === "string" && search.reason ? search.reason : undefined,
  }),
  ssr:false,
  component: WorkspaceRoute,
});

import { createFileRoute, Outlet, Link, redirect, useRouterState } from "@tanstack/react-router";
import { useHearthRole } from "../lib/useHearthRole";

function HearthLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) as string;
  const { isSuperadmin, teamsLoading, sessionLoading, canViewRuntimes, canViewBindings } = useHearthRole();

  const isLoading = sessionLoading || teamsLoading;
  const showUsage = !isLoading && isSuperadmin;
  const showProviders = !isLoading && isSuperadmin;
  const showRuntimes = !teamsLoading && canViewRuntimes;
  const showBindings = !teamsLoading && canViewBindings;
  const showAgents = !isLoading && isSuperadmin;

  const isRuns = pathname === "/hearth/runs" || pathname === "/hearth" || pathname === "/hearth/runs/";
  const isUsage = pathname === "/hearth/usage" || pathname.startsWith("/hearth/usage/");
  const isProviders = pathname === "/hearth/providers" || pathname.startsWith("/hearth/providers/");
  const isRuntimes = pathname === "/hearth/runtimes" || pathname.startsWith("/hearth/runtimes/");
  const isBindings = pathname === "/hearth/bindings" || pathname.startsWith("/hearth/bindings/");
  const isAgents = pathname === "/hearth/agents" || pathname.startsWith("/hearth/agents/");

  return (
    <main className="page-frame page-frame-narrow">
      <div className="flex items-center justify-between mb-3">
        <h1 className="font-display text-2xl weight-600 color-primary mb-0" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
          </svg>
          Hearth
        </h1>
      </div>
      <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>
        Hearth operations — runs, usage, providers, runtimes, bindings, and agents in one shell. Tabs hide when not authorized; direct hits redirect to /hearth/runs.
      </p>

      <div className="tab-bar" style={{ marginTop: 16 }}>
        <Link to="/hearth/runs" className={isRuns ? "tab-btn active" : "tab-btn"}>
          Runs
        </Link>
        {showUsage && (
          <Link to="/hearth/usage" className={isUsage ? "tab-btn active" : "tab-btn"}>
            Usage
          </Link>
        )}
        {showProviders && (
          <Link to="/hearth/providers" className={isProviders ? "tab-btn active" : "tab-btn"}>
            Providers
          </Link>
        )}
        {showRuntimes && (
          <Link to="/hearth/runtimes" className={isRuntimes ? "tab-btn active" : "tab-btn"}>
            Runtimes
          </Link>
        )}
        {showBindings && (
          <Link to="/hearth/bindings" className={isBindings ? "tab-btn active" : "tab-btn"}>
            Bindings
          </Link>
        )}
        {showAgents && (
          <Link to="/hearth/agents" className={isAgents ? "tab-btn active" : "tab-btn"}>
            Agents
          </Link>
        )}
      </div>

      <Outlet />
    </main>
  );
}

export const Route = createFileRoute("/hearth")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/hearth" || location.pathname === "/hearth/") {
      // Intentional: forward full search so ?task deep-links survive the canonical redirect.
      const search = location.search as Record<string, unknown>;
      throw redirect({
        to: "/hearth/runs",
        search: search as never,
      } as never);
    }
  },
  component: HearthLayout,
});

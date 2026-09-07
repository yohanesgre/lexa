import { createFileRoute, Outlet, Link, redirect, useRouterState } from "@tanstack/react-router";
import { useHearthRole } from "../lib/useHearthRole";

// Hearth shell tabs (wireframes/src/hearth-*.html tab bars): Runs always
// visible; the rest hide per role. Data-driven so the layout stays flat.
const HEARTH_TABS: Array<{ to: string; label: string; also?: string[]; superadmin?: boolean; can?: "canViewRuntimes" | "canViewBindings" }> = [
  { to: "/hearth/runs", label: "Runs", also: ["/hearth"] },
  { to: "/hearth/usage", label: "Usage", superadmin: true },
  { to: "/hearth/providers", label: "Providers", superadmin: true },
  { to: "/hearth/runtimes", label: "Runtimes", can: "canViewRuntimes" },
  { to: "/hearth/bindings", label: "Bindings", can: "canViewBindings" },
  { to: "/hearth/agents", label: "Agents", superadmin: true },
];

type HearthRole = { isSuperadmin: boolean; teamsLoading: boolean; sessionLoading: boolean; canViewRuntimes: boolean; canViewBindings: boolean };

function isTabActive(pathname: string, tab: (typeof HEARTH_TABS)[number]): boolean {
  return (tab.also?.includes(pathname) ?? false) || pathname === tab.to || pathname === `${tab.to}/` || pathname.startsWith(`${tab.to}/`);
}

function tabVisible(tab: (typeof HEARTH_TABS)[number], role: HearthRole): boolean {
  if (tab.superadmin) return !role.sessionLoading && !role.teamsLoading && role.isSuperadmin;
  if (tab.can === "canViewRuntimes") return !role.teamsLoading && role.canViewRuntimes;
  if (tab.can === "canViewBindings") return !role.teamsLoading && role.canViewBindings;
  return true;
}

function HearthLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) as string;
  const role = useHearthRole();

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
        {HEARTH_TABS.map((tab) => {
          if (!tabVisible(tab, role)) return null;
          return (
            <Link key={tab.to} to={tab.to} className={isTabActive(pathname, tab) ? "tab-btn active" : "tab-btn"}>
              {tab.label}
            </Link>
          );
        })}
      </div>

      <Outlet />
    </main>
  );
}

export const Route = createFileRoute("/hearth")({
  ssr:false,
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

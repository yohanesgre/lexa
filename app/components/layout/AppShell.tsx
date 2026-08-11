import { useMemo } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useProjectSelection } from "../../lib/project-selection";
import { clientLxkUser } from "../../lib/api";
import { ForgeStatus } from "../forge/ForgeStatus";
import { NavLink } from "./NavLink";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { UserProfile } from "./UserProfile";

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedSlug } = useProjectSelection();
  // Settings is an admin-only surface (same predicate as the settings page
  // sections): shown when no known user (dev / Access-less) or admin, hidden
  // for known members. The server enforces — the link is just the affordance.
  const user = clientLxkUser();
  const showSettings = !user || user.role === "admin";

  const routeType: "home" | "dashboard" | "board" | "tasks" | "wiki" | "settings" | "forge" = useMemo(() => {
    if (pathname === "/") return "home";
    if (pathname === "/forge") return "forge";
    if (pathname === "/settings") return "settings";
    if (pathname.match(/^\/[^/]+\/board$/)) return "board";
    if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
    if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
    if (pathname.match(/^\/[^/]+\/settings$/)) return "settings";
    if (pathname.match(/^\/[^/]+$/)) return "dashboard";
    return "home";
  }, [pathname]);

  const isSetup = pathname === "/setup";

  const dashboardTo = selectedSlug ? "/$slug" : "/";
  const boardTo = selectedSlug ? "/$slug/board" : "/";
  const wikiTo = selectedSlug ? "/$slug/wiki" : "/";
  const tasksTo = selectedSlug ? "/$slug/tasks" : "/";
  const dashboardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const boardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const wikiParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const tasksParams = selectedSlug ? { slug: selectedSlug } : undefined;

  return (
    <>
      {!isSetup && (
        <nav className="app-nav">
          <Link to="/" className={routeType === "home" ? "nav-brand active" : "nav-brand"}>
            Lexa
          </Link>
          <div className="nav-links">
            <NavLink to={dashboardTo} params={dashboardParams} active={routeType === "dashboard"} exact>
              Dashboard
            </NavLink>
            <NavLink to={boardTo} params={boardParams} active={routeType === "board"} exact>
              Board
            </NavLink>
            <NavLink to={tasksTo} params={tasksParams} active={routeType === "tasks"} exact>
              Tasks
            </NavLink>
            <NavLink to={wikiTo} params={wikiParams} active={routeType === "wiki"}>
              Wiki
            </NavLink>
            {showSettings && (
              <NavLink to="/settings" active={routeType === "settings"}>
                Settings
              </NavLink>
            )}
            <NavLink to="/forge" active={routeType === "forge"}>Forge</NavLink>
          </div>
          <div className="nav-spacer" />
          <div className="nav-right">
            <ForgeStatus />
            <ProjectSwitcher routeType={routeType} />
            <UserProfile />
          </div>
        </nav>
      )}
      <Outlet />
    </>
  );
}


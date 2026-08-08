import { useMemo } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useProjectSelection } from "../../lib/project-selection";
import { ForgeStatus } from "../forge/ForgeStatus";
import { NavLink } from "./NavLink";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { UserProfile } from "./UserProfile";

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedSlug } = useProjectSelection();

  const routeType: "dashboard" | "board" | "tasks" | "wiki" | "settings" = useMemo(() => {
    if (pathname === "/") return "dashboard";
    if (pathname === "/forge") return "dashboard";
    if (pathname === "/settings") return "settings";
    if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
    if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
    if (pathname.match(/^\/[^/]+\/settings$/)) return "settings";
    if (pathname.match(/^\/[^/]+$/)) return "board";
    return "dashboard";
  }, [pathname]);

  const isSetup = pathname === "/setup";

  const boardTo = selectedSlug ? "/$slug" : "/";
  const wikiTo = selectedSlug ? "/$slug/wiki" : "/";
  const tasksTo = selectedSlug ? "/$slug/tasks" : "/";
  const boardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const wikiParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const tasksParams = selectedSlug ? { slug: selectedSlug } : undefined;

  return (
    <>
      {!isSetup && (
        <nav className="app-nav">
          <div className="nav-brand">Lexa</div>
          <div className="nav-links">
            <NavLink to="/" exact>Dashboard</NavLink>
            <NavLink to={boardTo} params={boardParams} active={routeType === "board"} exact>
              Board
            </NavLink>
            <NavLink to={tasksTo} params={tasksParams} active={routeType === "tasks"} exact>
              Tasks
            </NavLink>
            <NavLink to={wikiTo} params={wikiParams} active={routeType === "wiki"}>
              Wiki
            </NavLink>
            <NavLink to="/settings" active={routeType === "settings"}>
              Settings
            </NavLink>
            <NavLink to="/forge">Forge</NavLink>
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


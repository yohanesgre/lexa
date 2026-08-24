import { useMemo } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useProjectSelection } from "../../lib/project-selection";
import { HearthStatus } from "../hearth/HearthStatus";
import { NavLink } from "./NavLink";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

// Full-screen surfaces with no app chrome: auth pages + the setup wizard.
const BARE_PATHS = new Set(["/setup", "/login", "/set-password", "/invite"]);

// Public wiki share reads render zero app chrome (token IS the credential).
const BARE_PREFIXES = ["/share/"];

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedSlug } = useProjectSelection();

  const routeType: "home" | "dashboard" | "board" | "tasks" | "wiki" | "chat" | "milestones" | "swimlanes" | "settings" | "hearth" = useMemo(() => {
    if (pathname === "/") return "home";
    if (pathname === "/hearth") return "hearth";
    if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
    if (pathname.match(/^\/[^/]+\/board$/)) return "board";
    if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
    if (pathname.match(/^\/[^/]+\/milestones$/)) return "milestones";
    if (pathname.match(/^\/[^/]+\/swimlanes$/)) return "swimlanes";
    if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
    if (pathname.match(/^\/[^/]+\/chat$/)) return "chat";
    if (pathname.match(/^\/[^/]+$/)) return "dashboard";
    return "home";
  }, [pathname]);

  const isBare = BARE_PATHS.has(pathname) || BARE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  const dashboardTo = selectedSlug ? "/$slug" : "/";
  const boardTo = selectedSlug ? "/$slug/board" : "/";
  const wikiTo = selectedSlug ? "/$slug/wiki" : "/";
  const chatTo = selectedSlug ? "/$slug/chat" : "/";
  const tasksTo = selectedSlug ? "/$slug/tasks" : "/";
  const milestonesTo = selectedSlug ? "/$slug/milestones" : "/";
  const swimlanesTo = selectedSlug ? "/$slug/swimlanes" : "/";
  const dashboardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const boardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const wikiParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const chatParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const tasksParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const milestonesParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const swimlanesParams = selectedSlug ? { slug: selectedSlug } : undefined;

  return (
    <>
      {!isBare && (
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
            <NavLink to={milestonesTo} params={milestonesParams} active={routeType === "milestones"} exact>
              Milestones
            </NavLink>
            <NavLink to={swimlanesTo} params={swimlanesParams} active={routeType === "swimlanes"} exact>
              Swimlanes
            </NavLink>
            <NavLink to={wikiTo} params={wikiParams} active={routeType === "wiki"}>
              Wiki
            </NavLink>
            <NavLink to={chatTo} params={chatParams} active={routeType === "chat"}>
              Chat
            </NavLink>
            <NavLink to="/hearth" active={routeType === "hearth"}>Hearth</NavLink>
          </div>
          <div className="nav-spacer" />
          <div className="nav-right">
            <ThemeToggle />
            <HearthStatus />
            <ProjectSwitcher routeType={routeType} />
            <UserMenu />
          </div>
        </nav>
      )}
      <Outlet />
    </>
  );
}

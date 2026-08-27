import { useEffect, useMemo, useState } from "react";
import { useScrollLock } from "../../lib/scroll-lock";
import { Link, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { Menu, X, PanelLeft, ChevronDown } from "lucide-react";
import { cn } from "../ui/cn";
import { useProjectSelection } from "../../lib/project-selection";
import { HearthStatus } from "../hearth/HearthStatus";
import { useProjects } from "../../lib/queries";
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
  const { selectedSlug, setSelectedSlug } = useProjectSelection();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const selectedProjectId = projects.find((p) => p.slug === selectedSlug)?.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectListOpen, setProjectListOpen] = useState(false);

  // Lock body scroll while the menu is open. Standard modal pattern —
  // the menu's own overflow handles content scrolling on touch.
  useEffect(() => {
    if (!menuOpen) return;
    return useScrollLock(menuOpen);
  }, [menuOpen]);

  // Close the mobile menu on route change so it doesn't linger over the
  // next page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Esc closes the mobile menu.
  useEffect(() => {
    if (!menuOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [menuOpen]);

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

  const navClass = menuOpen ? "app-nav app-nav-menu-open" : "app-nav";

  return (
    <>
      {!isBare && (
        <nav className={navClass}>
          {/* Context-sensitive sidebar toggle (mobile only). Shown on routes
             that own a left sidebar — wiki page tree, chat threads. Tapping
             dispatches a custom event that the layout component picks up. */}
          {(routeType === "wiki" || routeType === "chat") && (
            <button
              type="button"
              className="nav-sidebar-toggle"
              aria-label={routeType === "wiki" ? "Open page tree" : "Open threads"}
              onClick={() => {
                const event = routeType === "wiki" ? "lexa:toggle-wiki-sidebar" : "lexa:toggle-threads-sidebar";
                window.dispatchEvent(new CustomEvent(event));
              }}
            >
              <PanelLeft />
            </button>
          )}
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
          <button
            type="button"
            className="nav-hamburger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
          <div className="app-nav-menu" role="menu" aria-hidden={!menuOpen}>
            {selectedSlug && (
              <div className="app-nav-menu-project">
                <button
                  type="button"
                  className="app-nav-menu-project-toggle"
                  aria-expanded={projectListOpen}
                  onClick={() => setProjectListOpen((v) => !v)}
                >
                  <span className="app-nav-menu-project-label">Project</span>
                  <span className="app-nav-menu-project-name">
                    {projects.find((p) => p.slug === selectedSlug)?.name ?? selectedSlug}
                  </span>
                  <ChevronDown size={14} strokeWidth={1.5} className={projectListOpen ? "rotate-180" : ""} style={{ transition: "transform 200ms", flexShrink: 0 }} />
                </button>
                {projectListOpen && projects.length > 1 && (
                  <div className="app-nav-menu-project-list">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={cn("app-nav-menu-link", p.slug === selectedSlug && "active")}
                        onClick={() => {
                          setSelectedSlug(p.slug);
                          setProjectListOpen(false);
                          setMenuOpen(false);
                          navigate({ to: "/$slug", params: { slug: p.slug } });
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                    <div className="app-nav-menu-divider" />
                    {selectedProjectId && (
                      <Link
                        to="/settings/project/$projectId"
                        params={{ projectId: selectedProjectId! }}
                        className="app-nav-menu-action"
                        onClick={() => setMenuOpen(false)}
                      >
                        Project settings
                      </Link>
                    )}
                    <Link
                      to="/"
                      search={{ new: 1 } as never}
                      className="app-nav-menu-action"
                      onClick={() => setMenuOpen(false)}
                    >
                      Create new project
                    </Link>
                  </div>
                )}
              </div>
            )}
            <Link to={dashboardTo} {...(dashboardParams ? { params: dashboardParams } : {})} className="app-nav-menu-link" activeOptions={{ exact: true }}>
              Dashboard
            </Link>
            <Link to={boardTo} {...(boardParams ? { params: boardParams } : {})} className="app-nav-menu-link">
              Board
            </Link>
            <Link to={tasksTo} {...(tasksParams ? { params: tasksParams } : {})} className="app-nav-menu-link">
              Tasks
            </Link>
            <Link to={milestonesTo} {...(milestonesParams ? { params: milestonesParams } : {})} className="app-nav-menu-link">
              Milestones
            </Link>
            <Link to={swimlanesTo} {...(swimlanesParams ? { params: swimlanesParams } : {})} className="app-nav-menu-link">
              Swimlanes
            </Link>
            <Link to={wikiTo} {...(wikiParams ? { params: wikiParams } : {})} className="app-nav-menu-link">
              Wiki
            </Link>
            <Link to={chatTo} {...(chatParams ? { params: chatParams } : {})} className="app-nav-menu-link">
              Chat
            </Link>
            <Link to="/hearth" className="app-nav-menu-link">
              Hearth
            </Link>
          </div>
        </nav>
      )}
      {!isBare && menuOpen && (
        <button
          type="button"
          className="app-nav-backdrop"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <Outlet />
    </>
  );
}

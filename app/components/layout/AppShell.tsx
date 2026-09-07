import { useEffect, useMemo, useState } from "react";
import { lockScroll } from "../../lib/scroll-lock";
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

type RouteType = "home" | "dashboard" | "board" | "tasks" | "wiki" | "chat" | "milestones" | "swimlanes" | "settings" | "hearth";

function resolveRouteType(pathname: string): RouteType {
  if (pathname === "/") return "home";
  if (pathname === "/hearth" || pathname.startsWith("/hearth/")) return "hearth";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname.match(/^\/[^/]+\/board$/)) return "board";
  if (pathname.match(/^\/[^/]+\/tasks$/)) return "tasks";
  if (pathname.match(/^\/[^/]+\/milestones$/)) return "milestones";
  if (pathname.match(/^\/[^/]+\/swimlanes$/)) return "swimlanes";
  if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
  if (pathname.match(/^\/[^/]+\/chat$/)) return "chat";
  if (pathname.match(/^\/[^/]+$/)) return "dashboard";
  return "home";
}

function isBarePath(pathname: string) {
  return BARE_PATHS.has(pathname) || BARE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

interface NavTarget {
  to: string;
  params?: { slug: string } | undefined;
}

function navTarget(selectedSlug: string | null | undefined, path: string): NavTarget {
  if (!selectedSlug) return { to: "/" };
  return { to: path, params: { slug: selectedSlug } };
}

function linkProps(target: NavTarget) {
  if (target.params) return { to: target.to, params: target.params };
  return { to: target.to };
}

function SidebarToggleButton({ routeType }: { routeType: RouteType }) {
  const isWiki = routeType === "wiki";
  return (
    <button
      type="button"
      className="nav-sidebar-toggle"
      aria-label={isWiki ? "Open page tree" : "Open threads"}
      onClick={() => {
        const event = isWiki ? "lexa:toggle-wiki-sidebar" : "lexa:toggle-threads-sidebar";
        window.dispatchEvent(new CustomEvent(event));
      }}
    >
      <PanelLeft />
    </button>
  );
}

function MobileProjectMenu({ projects, selectedSlug, selectedProjectId, projectListOpen, onToggleList, onCloseMenu, onPickProject }: {
  projects: { id: string; slug: string; name: string }[];
  selectedSlug: string;
  selectedProjectId: string | undefined;
  projectListOpen: boolean;
  onToggleList: () => void;
  onCloseMenu: () => void;
  onPickProject: (slug: string) => void;
}) {
  return (
    <div className="app-nav-menu-project">
      <button
        type="button"
        className="app-nav-menu-project-toggle"
        aria-expanded={projectListOpen}
        onClick={onToggleList}
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
              onClick={() => onPickProject(p.slug)}
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
              onClick={onCloseMenu}
            >
              Project settings
            </Link>
          )}
          <Link
            to="/"
            search={{ new: 1 } as never}
            className="app-nav-menu-action"
            onClick={onCloseMenu}
          >
            Create new project
          </Link>
        </div>
      )}
    </div>
  );
}

function MobileMenuLinks({ targets }: { targets: {
  dashboard: NavTarget;
  board: NavTarget;
  tasks: NavTarget;
  milestones: NavTarget;
  swimlanes: NavTarget;
  wiki: NavTarget;
  chat: NavTarget;
} }) {
  return (
    <>
      <Link {...linkProps(targets.dashboard)} className="app-nav-menu-link" activeOptions={{ exact: true }}>
        Dashboard
      </Link>
      <Link {...linkProps(targets.board)} className="app-nav-menu-link">
        Board
      </Link>
      <Link {...linkProps(targets.tasks)} className="app-nav-menu-link">
        Tasks
      </Link>
      <Link {...linkProps(targets.milestones)} className="app-nav-menu-link">
        Milestones
      </Link>
      <Link {...linkProps(targets.swimlanes)} className="app-nav-menu-link">
        Swimlanes
      </Link>
      <Link {...linkProps(targets.wiki)} className="app-nav-menu-link">
        Wiki
      </Link>
      <Link {...linkProps(targets.chat)} className="app-nav-menu-link">
        Chat
      </Link>
      <Link to="/hearth" className="app-nav-menu-link">
        Hearth
      </Link>
    </>
  );
}

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
    return lockScroll(menuOpen);
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

  const routeType = useMemo(() => resolveRouteType(pathname), [pathname]);
  const isBare = isBarePath(pathname);

  const targets = {
    dashboard: navTarget(selectedSlug, "/$slug"),
    board: navTarget(selectedSlug, "/$slug/board"),
    wiki: navTarget(selectedSlug, "/$slug/wiki"),
    chat: navTarget(selectedSlug, "/$slug/chat"),
    tasks: navTarget(selectedSlug, "/$slug/tasks"),
    milestones: navTarget(selectedSlug, "/$slug/milestones"),
    swimlanes: navTarget(selectedSlug, "/$slug/swimlanes"),
  };

  const navClass = menuOpen ? "app-nav app-nav-menu-open" : "app-nav";

  return (
    <>
      {!isBare && (
        <nav className={navClass}>
          {/* Context-sensitive sidebar toggle (mobile only). Shown on routes
             that own a left sidebar — wiki page tree, chat threads. Tapping
             dispatches a custom event that the layout component picks up. */}
          {(routeType === "wiki" || routeType === "chat") && <SidebarToggleButton routeType={routeType} />}
          <Link to="/" className={routeType === "home" ? "nav-brand active" : "nav-brand"}>
            Lexa
          </Link>
          <div className="nav-links">
            <NavLink {...linkProps(targets.dashboard)} active={routeType === "dashboard"} exact>
              Dashboard
            </NavLink>
            <NavLink {...linkProps(targets.board)} active={routeType === "board"} exact>
              Board
            </NavLink>
            <NavLink {...linkProps(targets.tasks)} active={routeType === "tasks"} exact>
              Tasks
            </NavLink>
            <NavLink {...linkProps(targets.milestones)} active={routeType === "milestones"} exact>
              Milestones
            </NavLink>
            <NavLink {...linkProps(targets.swimlanes)} active={routeType === "swimlanes"} exact>
              Swimlanes
            </NavLink>
            <NavLink {...linkProps(targets.wiki)} active={routeType === "wiki"}>
              Wiki
            </NavLink>
            <NavLink {...linkProps(targets.chat)} active={routeType === "chat"}>
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
              <MobileProjectMenu
                projects={projects}
                selectedSlug={selectedSlug}
                selectedProjectId={selectedProjectId}
                projectListOpen={projectListOpen}
                onToggleList={() => setProjectListOpen((v) => !v)}
                onCloseMenu={() => setMenuOpen(false)}
                onPickProject={(slug) => {
                  setSelectedSlug(slug);
                  setProjectListOpen(false);
                  setMenuOpen(false);
                  navigate({ to: "/$slug", params: { slug } });
                }}
              />
            )}
            <MobileMenuLinks targets={targets} />
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

import { useEffect, useMemo, useState } from "react";
import { lockScroll } from "../../lib/scroll-lock";
import { Link, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Flag,
  Layers,
  LayoutDashboard,
  ListChecks,
  Menu,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  SquareKanban,
  X,
} from "lucide-react";
import { cn } from "../ui/cn";
import { useProjectSelection } from "../../lib/project-selection";
import { useProjects } from "../../lib/queries";
import { useAssistantEnabled } from "../../lib/assistant-enabled";
import { useSidebarState } from "../../lib/sidebar-state";
import { NavLink } from "./NavLink";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { ChevronIcon } from "./ChevronIcon";

// Full-screen surfaces with no app chrome: auth pages + the setup wizard.
const BARE_PATHS = new Set(["/setup", "/login", "/set-password", "/invite", "/device-login", "/settings/github/callback"]);

// Public wiki share reads render zero app chrome (token IS the credential).
const BARE_PREFIXES = ["/share/"];

type RouteType = "home" | "dashboard" | "board" | "tasks" | "wiki" | "chat" | "milestones" | "swimlanes" | "settings";

function resolveRouteType(pathname: string): RouteType {
  if (pathname === "/") return "home";
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

// Top-bar identity: the plain view name, beside the selected project slug.
const VIEW_LABEL: Record<RouteType, string> = {
  home: "Projects",
  dashboard: "Dashboard",
  board: "Board",
  tasks: "Tasks",
  wiki: "Wiki",
  chat: "Chat",
  milestones: "Milestones",
  swimlanes: "Swimlanes",
  settings: "Settings",
};

function isBarePath(pathname: string) {
  return BARE_PATHS.has(pathname) || BARE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

type NavKey = "dashboard" | "board" | "tasks" | "milestones" | "swimlanes" | "wiki" | "chat";

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

const NAV_ITEMS: { key: NavKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "board", label: "Board", icon: SquareKanban },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "milestones", label: "Milestones", icon: Flag },
  { key: "swimlanes", label: "Swimlanes", icon: Layers },
  { key: "wiki", label: "Wiki", icon: BookOpen },
];

// The map mark: two surveyor ridges. Drawn geometry, not a picture.
function RidgeMark() {
  return (
    <svg className="app-rail-mark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M1 19L8 7l4 6.4L15 7l8 12z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 7l2.2 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
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
        <ChevronIcon />
      </button>
      {projectListOpen && (
        <div className="app-nav-menu-project-list">
          {projects.length > 1 && projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn("app-nav-menu-link", p.slug === selectedSlug && "active")}
              onClick={() => onPickProject(p.slug)}
            >
              {p.name}
            </button>
          ))}
          {projects.length > 1 && <div className="app-nav-menu-divider" />}
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

function MobileMenuLinks({ targets, assistantEnabled }: { targets: Record<NavKey, NavTarget>; assistantEnabled: boolean }) {
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
      {assistantEnabled && (
        <Link {...linkProps(targets.chat)} className="app-nav-menu-link">
          Chat
        </Link>
      )}
    </>
  );
}

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedSlug, setSelectedSlug } = useProjectSelection();
  const navigate = useNavigate();
  // Bare surfaces (login, setup, share) have no session, the project list
  // would 401 and retry-spam the console. Skip the fetch there.
  const isBare = isBarePath(pathname);
  const { data: projects = [] } = useProjects({ enabled: !isBare });
  // Capability gate: hide the Chat nav entry on the Bun flavor where the
  // assistant surface is absent. Suppressed on bare pages (no session).
  const { enabled: assistantEnabled } = useAssistantEnabled({ enabled: !isBare });
  const selectedProjectId = projects.find((p) => p.slug === selectedSlug)?.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectListOpen, setProjectListOpen] = useState(false);

  // Rail collapse is persisted on desktop; below the breakpoint the rail is
  // out of the layout and the labelled menu takes over.
  const rail = useSidebarState({ storageKey: "lexa:rail-open", defaultOpen: true, breakpoint: 768 });

  // Lock body scroll while the menu is open. Standard modal pattern:
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

  const targets: Record<NavKey, NavTarget> = {
    dashboard: navTarget(selectedSlug, "/$slug"),
    board: navTarget(selectedSlug, "/$slug/board"),
    tasks: navTarget(selectedSlug, "/$slug/tasks"),
    milestones: navTarget(selectedSlug, "/$slug/milestones"),
    swimlanes: navTarget(selectedSlug, "/$slug/swimlanes"),
    wiki: navTarget(selectedSlug, "/$slug/wiki"),
    chat: navTarget(selectedSlug, "/$slug/chat"),
  };

  const activeByKey: Record<NavKey, boolean> = {
    dashboard: routeType === "dashboard",
    board: routeType === "board",
    tasks: routeType === "tasks",
    milestones: routeType === "milestones",
    swimlanes: routeType === "swimlanes",
    wiki: routeType === "wiki",
    chat: routeType === "chat",
  };

  if (isBare) {
    return <Outlet />;
  }

  return (
    <div className={cn("app-shell", menuOpen && "is-menu-open")}>
      <nav className="app-nav" data-open={rail.open ? "true" : "false"}>
        <div className="app-rail-head">
          <Link to="/" className={routeType === "home" ? "nav-brand active" : "nav-brand"}>
            <RidgeMark />
            <span className="nav-label">Lexa</span>
          </Link>
          {rail.isDesktop && (
            <button
              type="button"
              className="app-rail-toggle"
              aria-label={rail.open ? "Collapse navigation" : "Expand navigation"}
              aria-expanded={rail.open}
              onClick={rail.toggle}
            >
              {rail.open ? <PanelLeftClose /> : <PanelLeft />}
            </button>
          )}
        </div>
        <div className="nav-links">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <NavLink
              key={key}
              {...linkProps(targets[key])}
              active={activeByKey[key]}
              exact={key !== "wiki"}
            >
              <Icon aria-hidden="true" focusable="false" />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
          {assistantEnabled && (
            <NavLink {...linkProps(targets.chat)} active={activeByKey.chat}>
              <MessagesSquare aria-hidden="true" focusable="false" />
              <span className="nav-label">Chat</span>
            </NavLink>
          )}
        </div>
      </nav>

      <div className="app-frame">
        <header className="app-topbar">
          <button
            type="button"
            className="nav-hamburger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X aria-hidden="true" focusable="false" /> : <Menu aria-hidden="true" focusable="false" />}
            <span>Menu</span>
          </button>
          {(routeType === "wiki" || routeType === "chat") && <SidebarToggleButton routeType={routeType} />}
          <div className="app-topbar-title">
            <span className="app-topbar-name">{VIEW_LABEL[routeType]}</span>
            {selectedSlug && <span className="app-topbar-slug">{selectedSlug}</span>}
          </div>
          <div className="nav-spacer" />
          <div className="app-topbar-switcher">
            <ProjectSwitcher routeType={routeType} />
          </div>
          <div className="nav-right">
            <div className="app-topbar-account">
              <ThemeToggle />
              <UserMenu />
            </div>
            {selectedSlug ? (
              <Link
                to="/$slug/board"
                params={{ slug: selectedSlug }}
                search={{ new: true } as never}
                className="btn btn-primary btn-sm"
              >
                New task
              </Link>
            ) : (
              <Link to="/" search={{ new: 1 } as never} className="btn btn-primary btn-sm">
                New Project
              </Link>
            )}
          </div>
        </header>

        <div className="app-content">
          <Outlet />
        </div>
      </div>

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
        <MobileMenuLinks targets={targets} assistantEnabled={assistantEnabled} />
      </div>
      {menuOpen && (
        <button
          type="button"
          className="app-nav-backdrop"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

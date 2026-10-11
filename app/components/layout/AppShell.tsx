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

// The brand mark, copied verbatim from docs/brand/lexa-mark.svg: the LX
// monogram on its own plate. It is the one colour in the app outside the
// palette, because identity is the brand's job, not the world's.
function LexaMark() {
  return (
    <svg className="app-rail-mark" viewBox="0 0 64 64" width="24" height="24" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="var(--lx-brand-plate)" />
      <g fill="none" stroke="var(--lx-brand-ink)" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 16 V48 H26" />
        <path d="M29 16 L53 48 M53 16 L29 48" />
      </g>
    </svg>
  );
}

function PaneToggleButton({ routeType }: { routeType: RouteType }) {
  const isWiki = routeType === "wiki";
  const paneName = isWiki ? "Pages" : "Threads";
  const [open, setOpen] = useState(() => {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(isWiki ? "lexa:pane-wiki" : "lexa:pane-threads") !== "closed";
  });
  useEffect(() => {
    const onChange = (e: Event) => setOpen(Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open));
    window.addEventListener("lexa:pane-state", onChange);
    return () => window.removeEventListener("lexa:pane-state", onChange);
  }, []);
  return (
    <button
      type="button"
      className="nav-sidebar-toggle"
      aria-label={paneName}
      aria-expanded={open}
      aria-controls={isWiki ? "wiki-pane" : "threads-pane"}
      onClick={() => {
        window.dispatchEvent(new CustomEvent(isWiki ? "lexa:toggle-wiki-sidebar" : "lexa:toggle-threads-sidebar"));
      }}
    >
      {isWiki ? (
        <BookOpen aria-hidden="true" focusable="false" />
      ) : (
        <MessagesSquare aria-hidden="true" focusable="false" />
      )}
      <span className="nav-label">{paneName}</span>
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
    <div className={cn("app-shell", menuOpen && "is-menu-open")} data-rail-open={rail.open ? "true" : "false"}>
      <header className="app-band">
        <div className="app-band-brand">
          <Link to="/" className={routeType === "home" ? "nav-brand active" : "nav-brand"}>
            <LexaMark />
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
              {rail.open ? (
                <PanelLeftClose aria-hidden="true" focusable="false" />
              ) : (
                <PanelLeft aria-hidden="true" focusable="false" />
              )}
            </button>
          )}
        </div>
        <div className="app-topbar-inner">
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
          {(routeType === "wiki" || routeType === "chat") && <PaneToggleButton routeType={routeType} />}
          <div className="app-topbar-title">
            <span className="app-topbar-name">{VIEW_LABEL[routeType]}</span>
            {selectedSlug && <span className="app-topbar-slug">{selectedSlug}</span>}
          </div>
          <div className="nav-spacer" />
          <div className="app-topbar-switcher">
            <ProjectSwitcher routeType={routeType} />
          </div>
          <div className="app-topbar-account">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      <nav className="app-nav" data-open={rail.open ? "true" : "false"}>
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
        <div className="app-content">
          <Outlet />
        </div>
      </div>

      <div className="app-nav-menu" role="menu" aria-hidden={!menuOpen}>
        <div className="app-nav-menu-brand">
          <LexaMark />
          <span className="nav-label">Lexa</span>
        </div>
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

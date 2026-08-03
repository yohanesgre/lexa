import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import phosphorCss from "../styles/phosphor.css?url";
import { useProjects } from "../lib/queries";
import { ModalStackProvider } from "../components/ui/ModalStack";
import { ToastProvider } from "../components/ui/Toast";
import { ProjectSelectionProvider, useProjectSelection } from "../lib/project-selection";
import { ForgeStatus } from "../components/forge/ForgeStatus";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: "Lexa" }, { charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }],
    links: [
      { rel: "stylesheet", href: phosphorCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Departure+Mono&display=swap",
      },
    ],
  }),
  component: RootComponent,
});

function NavLink({
  to,
  params,
  active,
  exact = false,
  children,
}: {
  to: string;
  params?: Record<string, string>;
  active?: boolean;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = active ?? (pathname === to || pathname.startsWith(`${to}/`));
  return (
    <Link
      to={to}
      params={params}
      className={isActive ? "nav-link active" : "nav-link"}
      activeOptions={exact ? { exact: true } : undefined}
    >
      {children}
    </Link>
  );
}

function NavSpan({ children }: { children: React.ReactNode }) {
  return <span className="nav-link opacity-50 cursor-not-allowed">{children}</span>;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectSwitcher({ routeType }: { routeType: "dashboard" | "board" | "wiki" | "settings" }) {
  const [open, setOpen] = useState(false);
  const { data: projects, isLoading } = useProjects();
  const { selectedSlug, selectedProjectName, setSelectedSlug } = useProjectSelection();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const triggerLabel = isLoading
    ? "Loading…"
    : selectedProjectName ?? (projects && projects.length === 0 ? "No projects" : "Select project");

  const targetFor = (slug: string) => {
    if (routeType === "wiki") return "/$slug/wiki" as const;
    return "/$slug" as const;
  };

  return (
    <div ref={containerRef} className="project-switcher">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="project-switcher-trigger"
      >
        <span className="text-sm font-medium font-body text-lx-text-primary">{triggerLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="project-switcher-menu" onClick={() => setOpen(false)}>
          {!projects || isLoading ? (
            <div className="project-switcher-row">
              <span className="project-switcher-row-desc">Loading projects…</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="project-switcher-row">
              <span className="project-switcher-row-desc">No projects yet</span>
            </div>
          ) : (
            projects.map((project) => {
              const isCurrent = project.slug === selectedSlug;
              return (
                <Link
                  key={project.id}
                  to={targetFor(project.slug)}
                  params={{ slug: project.slug }}
                  className={isCurrent ? "project-switcher-row active" : "project-switcher-row"}
                  onClick={() => setSelectedSlug(project.slug)}
                >
                  <div className="project-switcher-row-info">
                    <span className="project-switcher-row-name">{project.name}</span>
                    <span className="project-switcher-row-desc">{project.slug}</span>
                  </div>
                </Link>
              );
            })
          )}
          <div className="project-switcher-separator" />
          <Link to="/" className="project-switcher-row" activeProps={{ className: "project-switcher-row" }}>
            <span className="project-switcher-row-name">Create new project</span>
          </Link>
        </div>
      )}
    </div>
  );
}

function UserProfile() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const user = { name: "Yohanes", email: "yohanesgre@gmail.com", role: "admin" as const };
  const initial = user.name[0].toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, height: 28,
          padding: "0 8px 0 6px", background: "transparent",
          border: "1px solid var(--lx-border-default)", borderRadius: 6,
          color: "var(--lx-text-primary)", cursor: "pointer",
        }}
      >
        <div className="avatar" style={{ width: 20, height: 20, fontSize: 10 }}>{initial}</div>
        <span className="text-sm font-medium" style={{ lineHeight: 1 }}>{user.name}</span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 180, zIndex: 40 }}>
          <div className="dropdown-label">Account</div>
          <div className="dropdown-item" style={{ gap: 8 }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </div>
          <div className="dropdown-separator" />
          <div className="dropdown-item" style={{ color: "var(--lx-text-danger)", gap: 8 }} onClick={() => { setOpen(false); }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </div>
        </div>
      )}
    </div>
  );
}

function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedSlug } = useProjectSelection();

  const routeType: "dashboard" | "board" | "wiki" | "settings" = useMemo(() => {
    if (pathname === "/") return "dashboard";
    if (pathname === "/forge") return "dashboard";
    if (pathname === "/settings") return "settings";
    if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
    if (pathname.match(/^\/[^/]+\/settings$/)) return "settings";
    if (pathname.match(/^\/[^/]+$/)) return "board";
    return "dashboard";
  }, [pathname]);

  const isSetup = pathname === "/setup";

  const boardTo = selectedSlug ? "/$slug" : "/";
  const wikiTo = selectedSlug ? "/$slug/wiki" : "/";
  const boardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const wikiParams = selectedSlug ? { slug: selectedSlug } : undefined;

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

function RootComponent() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <ModalStackProvider>
            <ToastProvider>
              <ProjectSelectionProvider>
                <AppShell />
              </ProjectSelectionProvider>
            </ToastProvider>
          </ModalStackProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

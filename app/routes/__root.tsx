import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useRef, useMemo } from "react";
import phosphorCss from "../styles/phosphor.css?url";
import { useProjects } from "../lib/queries";
import { stubTaskCount } from "../lib/dashboard-stubs";
import { ProjectSelectionProvider, useProjectSelection } from "../lib/project-selection";

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
  children,
}: {
  to: string;
  params?: Record<string, string>;
  active?: boolean;
  children: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = active ?? (pathname === to || pathname.startsWith(`${to}/`));
  return (
    <Link to={to} params={params} className={isActive ? "nav-link active" : "nav-link"}>
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
                  <span className="project-switcher-row-count">
                    {String(stubTaskCount(project.slug)).padStart(3, "0")}
                  </span>
                </Link>
              );
            })
          )}
          <div className="project-switcher-separator" />
          <Link to="/" className="project-switcher-row">
            <span className="project-switcher-row-name">Create new project</span>
          </Link>
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
    if (pathname.match(/^\/[^/]+\/wiki(?:\/.*)?$/)) return "wiki";
    if (pathname.match(/^\/[^/]+$/)) return "board";
    return "dashboard";
  }, [pathname]);

  const boardTo = selectedSlug ? "/$slug" : "/";
  const wikiTo = selectedSlug ? "/$slug/wiki" : "/";
  const boardParams = selectedSlug ? { slug: selectedSlug } : undefined;
  const wikiParams = selectedSlug ? { slug: selectedSlug } : undefined;

  return (
    <>
      <nav className="app-nav">
        <div className="nav-brand">Lexa</div>
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to={boardTo} params={boardParams} active={routeType === "board"}>
          Board
        </NavLink>
        <NavLink to={wikiTo} params={wikiParams} active={routeType === "wiki"}>
          Wiki
        </NavLink>
        <NavSpan>Settings</NavSpan>
        <ProjectSwitcher routeType={routeType} />
      </nav>
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
          <ProjectSelectionProvider>
            <AppShell />
          </ProjectSelectionProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

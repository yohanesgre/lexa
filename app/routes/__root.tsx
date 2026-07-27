import { HeadContent, Link, Outlet, Scripts, createRootRoute, useParams, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import phosphorCss from "../styles/phosphor.css?url";
import { useProjects } from "../lib/queries";

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

function NavLink({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link to={to} params={params} className={active ? "nav-link active" : "nav-link"}>
      {children}
    </Link>
  );
}

function NavSpan({ children }: { children: React.ReactNode }) {
  return <span className="nav-link opacity-50 cursor-not-allowed">{children}</span>;
}

function BoardDropdown({ active, currentSlug }: { active: boolean; currentSlug?: string }) {
  const [open, setOpen] = useState(false);
  const { data: projects } = useProjects();
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

  return (
    <div ref={containerRef} className="relative flex items-center h-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`nav-link flex items-center gap-1 ${active ? "active" : ""}`}
      >
        Board
        <svg className="w-3 h-3 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 min-w-[180px] rounded-md border border-lx-border bg-lx-surface-elevated shadow-lx-md z-dropdown py-1"
          onClick={() => setOpen(false)}
        >
          {!projects ? (
            <div className="px-3 py-2 text-sm text-lx-text-muted">Loading projects…</div>
          ) : projects.length === 0 ? (
            <div className="px-3 py-2 text-sm text-lx-text-muted">No projects yet</div>
          ) : (
            projects.map((project) => {
              const isCurrent = project.slug === currentSlug;
              return (
                <Link
                  key={project.id}
                  to="/$slug"
                  params={{ slug: project.slug }}
                  className={
                    isCurrent
                      ? "block px-3 py-1.5 text-sm text-lx-text-primary bg-lx-surface-selected"
                      : "block px-3 py-1.5 text-sm text-lx-text-secondary hover:bg-lx-surface-card-hover hover:text-lx-text-primary"
                  }
                >
                  {project.name}
                </Link>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function RootComponent() {
  const [queryClient] = useState(() => new QueryClient());
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params?.slug;
  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <nav className="app-nav">
            <div className="nav-brand">Lexa</div>
            <NavLink to="/">Dashboard</NavLink>
            <BoardDropdown active={Boolean(slug)} currentSlug={slug} />
            {slug ? (
              <NavLink to="/$slug/wiki" params={{ slug }}>
                Wiki
              </NavLink>
            ) : (
              <NavSpan>Wiki</NavSpan>
            )}
            <NavSpan>Settings</NavSpan>
          </nav>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

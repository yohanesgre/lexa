import { HeadContent, Link, Outlet, Scripts, createRootRoute, useParams, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import phosphorCss from "../styles/phosphor.css?url";

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
            {slug ? (
              <NavLink to="/$slug" params={{ slug: slug! }}>Board</NavLink>
            ) : (
              <NavSpan>Board</NavSpan>
            )}
            <NavSpan>Wiki</NavSpan>
            <NavSpan>Settings</NavSpan>
          </nav>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

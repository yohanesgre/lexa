import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
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

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link to={to} className={active ? "nav-link active" : "nav-link"}>
      {children}
    </Link>
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
          <nav className="app-nav">
            <div className="nav-brand">Lexa</div>
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/acceptance">Board</NavLink>
            <NavLink to="/wiki">Wiki</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

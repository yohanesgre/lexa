import { HeadContent, Outlet, Scripts, createRootRouteWithContext, redirect } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { TanStackDevtools } from "@tanstack/react-devtools";
import phosphorCss from "../styles/phosphor.css?url";
import { ModalStackProvider } from "../components/ui/ModalStack";
import { ToastProvider } from "../components/ui/Toast";
import { ProjectSelectionProvider } from "../lib/project-selection";
import { TeamSelectionProvider } from "../lib/team-selection";
import { AppShell } from "../components/layout/AppShell";
import { getSession } from "../lib/auth";
import type { RouterContext } from "../router";

// Public/auth surfaces — everything else requires a session. The guard runs
// on the server too (SSR cookie forwarding in getSession, try/catch inside);
// a missing/invalid session bounces to /login with the target remembered.
const PUBLIC_PATHS = new Set(["/login", "/set-password", "/invite", "/setup"]);

// Public wiki share reads: the token IS the credential (server enforces it
// per-request) — no session required. Prefix match because the token is a
// path param.
const PUBLIC_PREFIXES = ["/share/"];

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ location }) => {
    if (location.pathname.startsWith("/__inspect") || location.pathname.startsWith("/.vite-inspect")) return;
    if (PUBLIC_PATHS.has(location.pathname)) return;
    if (PUBLIC_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))) return;
    // Direct fetch, not the query cache: the guard must reflect the real
    // session cookie on every navigation, and seeding the cache here
    // interacts badly with useSession's staleTime (perpetual-loading / loop
    // on the login page). The client's useSession will populate the cache.
    const res = await getSession();
    if (!res.session) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
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

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var t=localStorage.getItem('lexa:theme');document.documentElement.dataset.theme=t==='light'?'light':'dark'}catch{}",
          }}
        />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <ModalStackProvider>
            <ToastProvider>
              <TeamSelectionProvider>
                <ProjectSelectionProvider>
                  <AppShell />
                </ProjectSelectionProvider>
              </TeamSelectionProvider>
            </ToastProvider>
          </ModalStackProvider>
          <TanStackDevtools />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

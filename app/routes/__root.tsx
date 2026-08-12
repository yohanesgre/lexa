import { HeadContent, Outlet, Scripts, createRootRoute, redirect } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import phosphorCss from "../styles/phosphor.css?url";
import { ModalStackProvider } from "../components/ui/ModalStack";
import { ToastProvider } from "../components/ui/Toast";
import { ProjectSelectionProvider } from "../lib/project-selection";
import { TeamSelectionProvider } from "../lib/team-selection";
import { AppShell } from "../components/layout/AppShell";
import { getSession } from "../lib/auth";

// Public/auth surfaces — everything else requires a session. The guard runs
// on the server too (SSR cookie forwarding in getSession, try/catch inside);
// a missing/invalid session bounces to /login with the target remembered.
const PUBLIC_PATHS = new Set(["/login", "/set-password", "/invite", "/setup"]);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return;
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
              <TeamSelectionProvider>
                <ProjectSelectionProvider>
                  <AppShell />
                </ProjectSelectionProvider>
              </TeamSelectionProvider>
            </ToastProvider>
          </ModalStackProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

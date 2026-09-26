import { useEffect } from "react";
import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useSession } from "../lib/queries";
import { useToast } from "../components/ui/Toast";

// /admin/assistant — the superadmin shell: fixed header + tab bar + <Outlet/>.
// The tabs are first-class child routes; Overview is the user-menu landing
// target. /admin/assistant/usage stays canonical (no redirect).
type AssistantTab =
  | "/admin/assistant"
  | "/admin/assistant/providers"
  | "/admin/assistant/agents"
  | "/admin/assistant/usage"
  | "/admin/assistant/runs"
  | "/admin/assistant/bindings";

const TABS: readonly { to: AssistantTab; label: string; exact?: boolean }[] = [
  { to: "/admin/assistant", label: "Overview", exact: true },
  { to: "/admin/assistant/providers", label: "Providers & Models" },
  { to: "/admin/assistant/agents", label: "Agents & Skills" },
  { to: "/admin/assistant/usage", label: "Usage & Costs" },
  { to: "/admin/assistant/runs", label: "Recent runs" },
  { to: "/admin/assistant/bindings", label: "Project bindings" },
];

// The index route resolves as `/admin/assistant/` (trailing slash), so the
// exact match against `/admin/assistant` must compare the normalized path.
function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function AssistantShell() {
  const { data: session, isLoading } = useSession();
  const isSuperadmin = session?.user?.role === "superadmin";
  const toast = useToast();
  const pathname = normalizePath(useRouterState({ select: (s) => s.location.pathname }) as string);

  useEffect(() => {
    if (!isLoading && !isSuperadmin) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, isSuperadmin, toast]);

  if (isLoading) return null;
  if (!isSuperadmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-0">Assistant</h1>
          <div className="font-micro text-2xs color-muted mt-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Control panel — providers, agents, usage, runs, and per-project bindings
          </div>
        </div>
      </div>

      <div className="ms-tabs">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.to : pathname.startsWith(t.to);
          return (
            <Link key={t.to} to={t.to} className={active ? "ms-tab active" : "ms-tab"} style={{ textDecoration: "none" }}>
              {t.label}
            </Link>
          );
        })}
      </div>

      <Outlet />
    </main>
  );
}

export const Route = createFileRoute("/admin/assistant")({
  ssr: false,
  component: AssistantShell,
});

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createFileRoute, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle, Check } from "lucide-react";
import { useCompleteGithubSetup, useSession, useTeams } from "../../lib/queries";
import { GITHUB_CALLBACK_FAILURE_COPY, githubCallbackOutcome, githubFailureReason, hasGithubAppSlug } from "../../components/settings/github-sync-logic";

// Landing surface GitHub redirects to after App creation / authorization
// (wireframes/src/settings-github-callback.html). No app chrome (BARE_PATHS in
// AppShell); a session + superadmin are required — the server enforces the same
// authority on POST /api/settings/github/setup, this only avoids rendering the
// flow to the wrong user.
type CallbackPhase = "working" | "connected" | "cancelled" | "invalid" | "failed";

export const Route = createFileRoute("/settings/github/callback")({
  validateSearch: (search: Record<string, unknown>): { code?: string | undefined; state?: string | undefined; error?: string | undefined } => ({
    code: typeof search.code === "string" && search.code ? search.code : undefined,
    state: typeof search.state === "string" && search.state ? search.state : undefined,
    error: typeof search.error === "string" && search.error ? search.error : undefined,
  }),
  ssr: false,
  component: GithubCallbackRoute,
});

function GithubCallbackRoute() {
  const { code, state, error } = Route.useSearch();
  return <GithubCallbackPage code={code} state={state} error={error} />;
}

const BACK_LINK_STYLE: CSSProperties = {
  height: 32,
  padding: "0 14px",
  fontSize: 12,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

export function GithubCallbackPage({ code, state, error }: { code?: string | undefined; state?: string | undefined; error?: string | undefined }) {
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();
  const navigate = useNavigate();
  const complete = useCompleteGithubSetup();
  const outcome = githubCallbackOutcome({ code, state, error });
  const [phase, setPhase] = useState<CallbackPhase>(outcome === "invalid" ? "invalid" : "working");
  const started = useRef(false);

  // An `invalid` state (no `state` param) never calls the server — there is
  // nothing to consume. A held `state` is always consumed server-side, even
  // when consent was cancelled (`code` absent).
  useEffect(() => {
    if (started.current || outcome === "invalid" || !session?.user || session.user.role !== "superadmin") return;
    started.current = true;
    complete.mutate(
      { code, state: state ?? "" },
      {
        onSuccess: () => setPhase(code ? "connected" : "cancelled"),
        onError: (err) => {
          const apiError = err as Error & { code?: string | undefined };
          if (apiError.code === "GITHUB_MANIFEST_STATE_INVALID") {
            setPhase("invalid");
            return;
          }
          console.warn(`[GitHub callback] setup failed (${githubFailureReason(apiError.code)})`);
          setPhase("failed");
        },
      }
    );
    // `complete` is intentionally omitted — its identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, code, state, session]);

  // Success confirms briefly, then returns to the GitHub Sync section with the
  // result the settings surface renders as the connected banner.
  useEffect(() => {
    if (phase !== "connected") return;
    const timer = setTimeout(() => {
      void navigate({ to: "/settings/workspace", search: { tab: "integrations", github: "connected" } });
    }, 1500);
    return () => clearTimeout(timer);
  }, [phase, navigate]);

  if (isLoading) return null;
  if (session?.user && session.user.role !== "superadmin") {
    const isTeamAdmin = teams && teams.length > 0;
    return <Navigate to={isTeamAdmin ? "/settings/team" : "/settings/me"} replace />;
  }
  if (!session?.user) return null;

  const settings = complete.data;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div className="font-display text-xl font-semibold text-lx-text-primary mb-1" style={{ textAlign: "center" }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>GitHub connection</p>

        {phase === "working" && (
          <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, margin: "8px 0 12px" }}>
              <span className="spinner" style={{ width: 18, height: 18 }} />
              <span className="text-sm font-medium text-lx-text-primary" style={{ fontSize: 15 }}>Finishing GitHub connection…</span>
            </div>
            <p className="text-xs text-lx-text-secondary" style={{ textAlign: "center", lineHeight: 1.5, margin: "0 0 4px" }}>
              Verifying the one-time link and storing the App credentials. You can leave this tab open.
            </p>
          </div>
        )}

        {phase === "connected" && (
          <div className="card-panel mt-6" style={{ boxShadow: "var(--lx-shadow-sm)", textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 9999, background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", margin: "0 auto 12px" }}>
              <Check size={18} strokeWidth={2.5} />
            </div>
            <div className="text-sm font-medium text-lx-text-primary mb-1" style={{ fontSize: 15 }}>GitHub connected</div>
            <p className="text-xs text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>
              App{settings && hasGithubAppSlug(settings) ? <> <span className="font-mono">{settings.appSlug}</span> (ID <span className="font-mono">{settings.appId}</span>)</> : settings ? <> ID <span className="font-mono">{settings.appId}</span></> : null} is wired up — the webhook URL was set automatically and the private key + secret are stored encrypted.
            </p>
            <Link to="/settings/workspace" search={{ tab: "integrations", github: "connected" }} className="btn btn-ghost" style={BACK_LINK_STYLE}>
              Back to settings now
            </Link>
          </div>
        )}

        {phase === "cancelled" && (
          <div className="card-panel mt-6" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            <div className="notice notice-warning" style={{ marginBottom: 12 }}>
              <AlertTriangle size={14} strokeWidth={1.5} />
              <span>Connection cancelled — nothing was changed.</span>
            </div>
            <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: "0 0 12px" }}>
              Your existing GitHub configuration, if any, is untouched. Start the connection again whenever you&apos;re ready.
            </p>
            <Link to="/settings/workspace" search={{ tab: "integrations" }} className="btn btn-ghost" style={BACK_LINK_STYLE}>
              Back to settings
            </Link>
          </div>
        )}

        {phase === "invalid" && (
          <div className="card-panel mt-6" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            <div className="notice notice-danger" style={{ marginBottom: 12 }}>
              <AlertCircle size={14} strokeWidth={1.5} />
              <span>This connection link is no longer valid.</span>
            </div>
            <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: "0 0 12px" }}>
              Connection links are single-use and short-lived. Start a fresh one from Settings — the old link cannot be reused, and nothing was changed.
            </p>
            <Link to="/settings/workspace" search={{ tab: "integrations" }} className="btn btn-ghost" style={BACK_LINK_STYLE}>
              Back to settings
            </Link>
          </div>
        )}

        {phase === "failed" && (
          <div className="card-panel mt-6" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            <div className="notice notice-danger" style={{ marginBottom: 12 }}>
              <AlertCircle size={14} strokeWidth={1.5} />
              <span>{GITHUB_CALLBACK_FAILURE_COPY}</span>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/settings/workspace" search={{ tab: "integrations" }} className="btn btn-primary" style={BACK_LINK_STYLE}>
                Retry from settings
              </Link>
              <Link to="/settings/workspace" search={{ tab: "integrations" }} className="btn btn-ghost" style={BACK_LINK_STYLE}>
                Back to settings
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

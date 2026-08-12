import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSession, useSignIn } from "../lib/queries";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { data: session, isLoading } = useSession();
  const navigate = useNavigate();
  const { redirect: redirectParam } = Route.useSearch();
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (isLoading) return null;
  if (session?.user) return <Navigate to="/" replace />;

  const target = (redirectParam || "/").startsWith("/") ? redirectParam! : "/";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          navigate({ to: target as never });
        },
        onError: (err) => {
          setError(err.message || "Invalid email or password.");
        },
      }
    );
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="font-display text-xl weight-600 mb-1" style={{ textAlign: "center", fontSize: 24 }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>Sign in to your workspace</p>

        <form onSubmit={handleSubmit} style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 10, padding: 24, boxShadow: "0 1px 0 rgba(0,0,0,0.2)" }}>
          {error && (
            <div className="notice notice-danger mb-4">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <span>Invalid email or password.</span>
            </div>
          )}

          <div className="field" style={{ marginBottom: 12 }}>
            <label className="field-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="prop-input w-full"
              type="email"
              placeholder="you@example.com"
              autoComplete="username"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
            />
          </div>

          <div className="field" style={{ marginBottom: 16 }}>
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="login-password">Password</label>
              <span className="text-xs text-lx-text-muted" style={{ fontSize: 11 }}>Forgot password? Contact your admin</span>
            </div>
            <input
              id="login-password"
              className="prop-input w-full"
              type="password"
              placeholder="••••••••••••"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
            />
          </div>

          <button className="btn btn-primary w-full" style={{ height: 36 }} disabled={signIn.isPending}>
            {signIn.isPending ? "Logging in…" : "Log in"}
          </button>

          <div className="field-hint" style={{ marginTop: 12, textAlign: "center" }}>
            No account yet? You were invited — check your email for the sign-up link.
          </div>
        </form>
      </div>
    </main>
  );
}

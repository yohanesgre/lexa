import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSession, useSignIn } from "../lib/queries";
import { Field } from "../components/ui/Field";
import { TextInput } from "../components/ui/TextInput";

export const Route = createFileRoute("/login")({
  // @ts-expect-error — strict: exactOptional indexedAccess
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { data: session, isLoading } = useSession();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh sign-in completes → always land on home. Simpler and reliable:
  // avoids dynamic-path navigation entirely (the ?redirect= param stays in
  // the URL but home is the single landing point).
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          void navigate({ to: "/" });
        },
        onError: (err) => {
          setError(err.message || "Invalid email or password.");
        },
      }
    );
  };

  if (isLoading) return null;
  // Already signed in — leave the login page for home.
  if (session?.user) return <Navigate to="/" replace />;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="font-display text-xl weight-600 mb-1" style={{ textAlign: "center", fontSize: 24 }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>Sign in to your workspace</p>

        <form onSubmit={handleSubmit} className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
          {error && (
            <div className="notice notice-danger mb-4">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <span>Invalid email or password.</span>
            </div>
          )}

          <Field label="Email" htmlFor="login-email" className="field mb-3">
            <TextInput id="login-email" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(v) => { setEmail(v); if (error) setError(null); }} />
          </Field>

          <div className="field mb-4">
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="login-password">Password</label>
              <span className="text-xs text-lx-text-muted" style={{ fontSize: 11 }}>Forgot password? Contact your admin</span>
            </div>
            <div className="input-affix">
              <input
                id="login-password"
                className="prop-input w-full"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
              />
              <button
                type="button"
                className="password-toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={signIn.isPending}>
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
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSession, useSignIn } from "../lib/queries";
import { getSetupStatus } from "../lib/api";
import { Field } from "../components/ui/Field";
import { TextInput } from "../components/ui/TextInput";
import { PasswordField } from "../components/ui/PasswordField";
import { NoticeDanger } from "../components/ui/NoticeDanger";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  ssr: false,
  component: LoginPage,
});

function LoginPage() {
  const { data: session, isLoading } = useSession();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Unconfigured instance — there is no superadmin to sign in as; the
  // wizard is the only entry point. Direct fetch (same reasoning as the
  // root guard: no query-cache interaction). Configured instances keep
  // the login form.
  useEffect(() => {
    if (isLoading || session?.user) return;
    let alive = true;
    void getSetupStatus().then((status) => {
      if (!alive || status.configured) return;
      void navigate({ to: "/setup", replace: true });
    });
    return () => {
      alive = false;
    };
  }, [isLoading, session?.user, navigate]);

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
            <NoticeDanger>Invalid email or password.</NoticeDanger>
          )}

          <Field label="Email" htmlFor="login-email" className="field mb-3">
            <TextInput id="login-email" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(v) => { setEmail(v); if (error) setError(null); }} />
          </Field>

          <div className="field mb-4">
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="login-password">Password</label>
              <span className="text-xs text-lx-text-muted" style={{ fontSize: 11 }}>Forgot password? Contact your admin</span>
            </div>
            <PasswordField id="login-password" value={password} onChange={(v) => { setPassword(v); if (error) setError(null); }} />
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
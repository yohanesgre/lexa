import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useCapabilities, useRequestPasswordReset, useSession, useSignIn } from "../lib/queries";
import { getSetupStatus } from "../lib/api";
import { authErrorCode, authErrorStatus } from "../lib/auth";
import { Field } from "../components/ui/Field";
import { TextInput } from "../components/ui/TextInput";
import { PasswordField } from "../components/ui/PasswordField";
import { NoticeDanger } from "../components/ui/NoticeDanger";
import { safeRedirect } from "../lib/safe-redirect";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  ssr: false,
  component: LoginPage,
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECOVERY_ACK = "If an active account exists for this email, you’ll receive a password reset link.";

function LoginPage() {
  const { data: session, isLoading } = useSession();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const capabilities = useCapabilities();
  const requestReset = useRequestPasswordReset();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "recovery">("signin");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryFieldError, setRecoveryFieldError] = useState<string | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);
  // Fail closed: absent capabilities (older build or failed read) and a native
  // RESET_PASSWORD_DISABLED response both keep the contact-admin copy instead
  // of offering a request form that cannot work.
  const [recoveryDisabled, setRecoveryDisabled] = useState(false);
  const canRecover = capabilities.data?.passwordRecovery === true && !recoveryDisabled;
  const signInFormRef = useRef<HTMLFormElement | null>(null);
  const recoveryFormRef = useRef<HTMLFormElement | null>(null);
  const previousModeRef = useRef<"signin" | "recovery" | null>(null);

  // Move focus into the form that replaced the old one; the first render keeps
  // the browser's own focus (no programmatic focus steal on page load).
  useEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = mode;
    if (previous === null || previous === mode) return;
    const form = mode === "recovery" ? recoveryFormRef.current : signInFormRef.current;
    form?.querySelector<HTMLInputElement>("input")?.focus();
  }, [mode]);

  // A capabilities change while the form is open (configuration removed, read
  // failed) returns the surface to the contact-admin fallback.
  useEffect(() => {
    if (!canRecover) setMode("signin");
  }, [canRecover]);

  const resetNotice = requestReset.isError && !recoveryFieldError
    ? authErrorStatus(requestReset.error) === 429
      ? "Too many requests. Try again later."
      : "Could not submit your request. Try again."
    : null;

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

  // Fresh sign-in completes → return to the internal `?redirect=` target when
  // one was supplied (root guard sets it to the originally requested path),
  // otherwise home.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          void navigate({ to: safeRedirect(redirect) } as never);
        },
        onError: (err) => {
          setError(err.message || "Invalid email or password.");
        },
      }
    );
  };

  const openRecovery = () => {
    requestReset.reset();
    setRecoveryAck(false);
    setRecoveryFieldError(null);
    setMode("recovery");
  };

  const closeRecovery = () => {
    requestReset.reset();
    setRecoveryAck(false);
    setRecoveryFieldError(null);
    setMode("signin");
  };

  const handleRecoverySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (requestReset.isPending) return;
    const normalized = recoveryEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
      setRecoveryFieldError("Enter a valid email address.");
      return;
    }
    setRecoveryFieldError(null);
    setRecoveryAck(false);
    requestReset.mutate(normalized, {
      onSuccess: () => setRecoveryAck(true),
      onError: (err) => {
        const code = authErrorCode(err);
        if (code === "RESET_PASSWORD_DISABLED") {
          setRecoveryDisabled(true);
          setMode("signin");
        } else if (code === "INVALID_INPUT") {
          setRecoveryFieldError("Enter a valid email address.");
        }
      },
    });
  };

  if (isLoading) return null;
  // Already signed in — leave the login page for the same internal target the
  // submit path would use (defaults to home).
  if (session?.user) return <Navigate to={safeRedirect(redirect) as never} replace />;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="font-display text-xl font-semibold mb-1" style={{ textAlign: "center", fontSize: 24 }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>
          {mode === "recovery" ? "Reset your password" : "Sign in to your workspace"}
        </p>

        {mode === "recovery" ? (
          <form ref={recoveryFormRef} onSubmit={handleRecoverySubmit} noValidate className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            {recoveryAck && (
              <div className="notice notice-success mb-4" role="status">
                <CheckCircle2 size={14} strokeWidth={1.5} />
                <span>{RECOVERY_ACK}</span>
              </div>
            )}
            {resetNotice && !recoveryAck && (
              <div role="alert"><NoticeDanger>{resetNotice}</NoticeDanger></div>
            )}

            <Field label="Email" htmlFor="recovery-email" error={recoveryFieldError ?? undefined} className="field mb-4">
              <TextInput
                id="recovery-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                value={recoveryEmail}
                onChange={(v) => {
                  setRecoveryEmail(v);
                  if (recoveryFieldError) setRecoveryFieldError(null);
                  if (requestReset.isError) requestReset.reset();
                }}
                disabled={requestReset.isPending}
              />
            </Field>

            <button type="submit" className="btn btn-primary w-full" style={{ height: 44 }} disabled={requestReset.isPending}>
              {requestReset.isPending ? "Requesting reset…" : "Send reset link"}
            </button>
            <button type="button" className="btn btn-ghost w-full" style={{ height: 44, marginTop: 8 }} onClick={closeRecovery}>
              Back to sign in
            </button>
          </form>
        ) : (
          <form ref={signInFormRef} onSubmit={handleSubmit} className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
            {error && (
              <NoticeDanger>{error}</NoticeDanger>
            )}

            <Field label="Email" htmlFor="login-email" className="field mb-3">
              <TextInput id="login-email" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(v) => { setEmail(v); if (error) setError(null); }} />
            </Field>

            <div className="field mb-4">
              <div className="flex items-center justify-between">
                <label className="field-label" htmlFor="login-password">Password</label>
                {!canRecover && !capabilities.isLoading && <span className="text-xs text-lx-text-muted" style={{ fontSize: 11 }}>Forgot password? Contact your admin</span>}
              </div>
              <PasswordField id="login-password" value={password} onChange={(v) => { setPassword(v); if (error) setError(null); }} />
              {canRecover && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" className="sl-link-btn" style={{ minHeight: 44, padding: "0 6px", display: "inline-flex", alignItems: "center" }} onClick={openRecovery}>
                    Forgot password?
                  </button>
                </div>
              )}
            </div>

            <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={signIn.isPending}>
              {signIn.isPending ? "Logging in…" : "Log in"}
            </button>

            <div className="field-hint" style={{ marginTop: 12, textAlign: "center" }}>
              No account yet? You were invited — check your email for the sign-up link.
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
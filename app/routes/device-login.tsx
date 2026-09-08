import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSession, useSignIn, useDeviceLoginRequest, useApproveDeviceLogin, useDenyDeviceLogin } from "../lib/queries";
import { NoticeDanger } from "../components/ui/NoticeDanger";

// /device-login — approve surface for lexa-cli pairing (wireframes/src/device-login.html).
// The verifyUrl carries request id + token; approval needs session + token both.
export const Route = createFileRoute("/device-login")({
  validateSearch: (search: Record<string, unknown>): { request?: string | undefined; token?: string | undefined } => ({
    request: typeof search.request === "string" && search.request ? search.request : undefined,
    token: typeof search.token === "string" && search.token ? search.token : undefined,
  }),
  ssr: false,
  component: DeviceLoginPage,
});

function CodeInline({ children }: { children: string }) {
  return (
    <code style={{ fontFamily: "var(--lx-font-mono)", fontSize: 12, background: "var(--lx-surface-elevated)", padding: "2px 4px", borderRadius: 4, color: "var(--lx-text-secondary)" }}>
      {children}
    </code>
  );
}

function IconFrame({ children, tone }: { children: React.ReactNode; tone: "neutral" | "success" | "warning" }) {
  const style =
    tone === "success"
      ? { background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", borderRadius: 9999, width: 36, height: 36 }
      : tone === "warning"
        ? { background: "var(--lx-bg-warning-subtle)", border: "1px solid rgba(240,192,64,0.15)", color: "var(--lx-text-warning)", borderRadius: 12, width: 48, height: 48 }
        : { background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", color: "var(--lx-text-muted)", borderRadius: 12, width: 48, height: 48 };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", ...style }}>
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div className="font-display text-xl weight-600 mb-1" style={{ textAlign: "center" }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>Approve device login</p>
        {children}
      </div>
    </main>
  );
}

function expiresInLabel(expiresAt: string, now: number): string {
  const min = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
  return `expires in ${min} min`;
}

function ExpiredVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <div className="notice notice-danger mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        <span>This request has expired.</span>
      </div>
      <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: 0 }}>
        Device-login requests are valid for 10 minutes. Run <CodeInline>lexa-cli login &lt;URL&gt;</CodeInline> again to mint a new one.
      </p>
    </div>
  );
}

function NotFoundVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <div className="notice notice-danger mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        <span>Request not found.</span>
      </div>
      <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: 0 }}>
        The link is unknown or was already used — approval consumes the request and returns the raw key to the CLI exactly once. Start a new <CodeInline>lexa-cli login</CodeInline> and open its fresh link. The API never distinguishes unknown ids from consumed ones (no oracle).
      </p>
    </div>
  );
}

function DeniedVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <IconFrame tone="warning">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ textAlign: "center", fontSize: 15 }}>Request denied</div>
      <p className="text-xs text-lx-text-secondary" style={{ textAlign: "center", lineHeight: 1.5, margin: "0 0 16px" }}>
        You rejected the request — no key was minted. Run <CodeInline>lexa-cli login &lt;URL&gt;</CodeInline> again to start a fresh one; the CLI shows <span className="font-mono">DEVICE_LOGIN_DENIED</span>.
      </p>
    </div>
  );
}

function ApprovedVariant({ keyName }: { keyName: string }) {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)", textAlign: "center" }}>
      <IconFrame tone="success">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ fontSize: 15 }}>Selesai — cek terminal</div>
      <p className="text-xs text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>
        The CLI received the raw key once (name: <span className="font-mono">{keyName}</span>). It is bound to your account and listed under Settings → Me → API keys.
      </p>
      <Link to="/settings/me" className="btn btn-ghost" style={{ height: 32, padding: "0 14px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        Go to my API keys
      </Link>
    </div>
  );
}

function PendingVariant({ clientName, code, expiresAt, busy, onApprove, onDeny }: {
  clientName: string;
  code: string;
  expiresAt: string;
  busy: "approving" | "denying" | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <IconFrame tone="neutral">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ textAlign: "center", fontSize: 15 }}>Approve this device?</div>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <div className="font-mono text-base weight-500">{clientName}</div>
        <div className="text-xs text-lx-text-muted" style={{ marginTop: 4 }}>
          code <span className="chip font-mono text-xs" style={{ background: "var(--lx-surface-input)" }}>{code}</span> · {expiresInLabel(expiresAt, now)}
        </div>
      </div>
      <p className="text-xs text-lx-text-secondary" style={{ textAlign: "center", lineHeight: 1.5, margin: "0 0 16px" }}>
        A terminal on this machine is requesting a key bound to your account. Approve mints the key once — the CLI prints it, and you can manage it in Settings → Me → API keys.
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-danger" style={{ flex: 1 }} onClick={onDeny} disabled={busy !== null}>
          {busy === "denying" ? (<><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />Denying…</>) : "Deny"}
        </button>
        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onApprove} disabled={busy !== null}>
          {busy === "approving" ? (<><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />Approving…</>) : "Approve"}
        </button>
      </div>
    </div>
  );
}

function NotSignedInVariant() {
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onError: (err) => {
          setError(err.message || "Invalid email or password.");
        },
      }
    );
  };

  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <div className="notice notice-warning mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
        <span>Sign in to approve this device login — approval requires an active session.</span>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="dl-email">Email</label>
          <input id="dl-email" className="prop-input w-full" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }} />
        </div>
        <div className="field" style={{ marginBottom: 16 }}>
          <label className="field-label" htmlFor="dl-password">Password</label>
          <div className="input-affix">
            <input id="dl-password" className="prop-input w-full" type={showPassword ? "text" : "password"} placeholder="••••••••••••" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }} />
            <button type="button" className="password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} title={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              )}
            </button>
          </div>
        </div>
        {error && <NoticeDanger>Invalid email or password.</NoticeDanger>}
        <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={signIn.isPending}>
          {signIn.isPending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

function DeviceLoginPage() {
  const { request, token } = Route.useSearch();
  const { data: session, isLoading: sessionLoading } = useSession();
  const [done, setDone] = useState<{ status: "approved" | "denied" | "expired" | "not-found"; keyName?: string } | null>(null);
  const [busy, setBusy] = useState<"approving" | "denying" | null>(null);
  const approve = useApproveDeviceLogin();
  const deny = useDenyDeviceLogin();
  const requestQuery = useDeviceLoginRequest(request ?? "", token ?? "");

  // Mutations are local-state driven (no shared cache); map their error codes
  // to the same variants as the initial GET.
  const handleAction = (action: "approve" | "deny") => {
    if (!request || !token || busy !== null) return;
    setBusy(action === "approve" ? "approving" : "denying");
    const mutation = action === "approve" ? approve : deny;
    mutation.mutate(
      { id: request, token },
      {
        onSuccess: (res) => {
          setBusy(null);
          setDone({ status: res.status, keyName: res.clientName });
        },
        onError: (err) => {
          setBusy(null);
          const code = (err as { code?: string }).code;
          if (code === "DEVICE_LOGIN_DENIED") setDone({ status: "denied" });
          else if (code === "DEVICE_LOGIN_EXPIRED") setDone({ status: "expired" });
          else setDone({ status: "not-found" });
        },
      }
    );
  };

  if (sessionLoading) return null;
  if (!session?.user) return <Shell><NotSignedInVariant /></Shell>;
  if (!request || !token) return <Shell><NotFoundVariant /></Shell>;

  // Terminal states first — the refetch (if any) may 404 once the CLI has
  // consumed the request; `done` is authoritative for what the user saw.
  if (done?.status === "approved" || requestQuery.data?.status === "approved") {
    const keyName = done?.keyName ?? (requestQuery.data?.status === "approved" ? requestQuery.data.keyName : "");
    return <Shell><ApprovedVariant keyName={keyName} /></Shell>;
  }
  if (done?.status === "denied") return <Shell><DeniedVariant /></Shell>;
  if (done?.status === "expired") return <Shell><ExpiredVariant /></Shell>;
  if (done?.status === "not-found") return <Shell><NotFoundVariant /></Shell>;

  const terminalCode = (err: unknown): string => (err as { code?: string })?.code ?? "";
  const getError = requestQuery.error;
  if (getError) {
    const code = terminalCode(getError);
    if (code === "DEVICE_LOGIN_DENIED") return <Shell><DeniedVariant /></Shell>;
    if (code === "DEVICE_LOGIN_EXPIRED") return <Shell><ExpiredVariant /></Shell>;
    return <Shell><NotFoundVariant /></Shell>;
  }
  if (requestQuery.isLoading) return null;
  const pending = requestQuery.data;
  if (!pending || pending.status !== "pending") return <Shell><NotFoundVariant /></Shell>;

  return (
    <Shell>
      <PendingVariant
        clientName={pending.clientName}
        code={pending.code}
        expiresAt={pending.expiresAt}
        busy={busy}
        onApprove={() => handleAction("approve")}
        onDeny={() => handleAction("deny")}
      />
    </Shell>
  );
}
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { InvalidTokenState } from "../components/auth/SetPasswordForm";
import { Field } from "../components/ui/Field";
import { TextInput } from "../components/ui/TextInput";
import { NoticeDanger } from "../components/ui/NoticeDanger";
import { useAcceptInvite, useSession, useSignIn } from "../lib/queries";

// Workspace invitation link ({baseURL}/invite?token=, 7d expiry, single-use).
// Consumes POST /api/auth/invite/accept { token, name, password } — NOT the
// reset-password endpoint (invite tokens live in workspace_invitations, not
// the verification table; see app/lib/auth.ts). Accept establishes no
// session, so success signs in with the returned email + chosen password
// before landing on /.
export const Route = createFileRoute("/invite")({
  validateSearch: (search: Record<string, unknown>): { token?: string | undefined } => ({
    token: typeof search.token === "string" && search.token ? search.token : undefined,
  }),
  ssr: false,
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useSearch();
  const { data: session, isLoading } = useSession();

  if (isLoading) return null;
  if (session?.user) return <Navigate to="/" replace />;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="font-display mb-1" style={{ textAlign: "center", fontSize: 24, fontWeight: 600 }}>Lexa</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>You&apos;re invited to Lexa</p>
        {token ? <InviteAcceptForm token={token} /> : <InvalidTokenState />}
      </div>
    </main>
  );
}

function InviteAcceptForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const accept = useAcceptInvite();
  const signIn = useSignIn();
  const [name, setName] = useState("");
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  const code = (accept.error as { code?: string | undefined } | null)?.code;
  const tooShort = password.length > 0 && password.length < 8;
  const pending = accept.isPending || signIn.isPending;
  const canSubmit = name.trim().length > 0 && password.length >= 8 && confirm.length > 0 && !tooShort && !confirmError && !pending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8 || password !== confirm) {
      if (password !== confirm) setConfirmError("Passwords do not match");
      return;
    }
    accept.mutate(
      { token, name: name.trim(), password },
      {
        onSuccess: (res) => {
          signIn.mutate(
            { email: res.email, password },
            {
              onSuccess: () => {
                void navigate({ to: "/" });
              },
              onError: () => setCreatedEmail(res.email),
            }
          );
        },
      }
    );
  };

  if (createdEmail) {
    return (
      <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)", textAlign: "center" }}>
        <div className="text-sm weight-500 mb-1" style={{ fontWeight: 500 }}>Account created</div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Sign in as {createdEmail} to continue.</p>
        <button className="btn btn-primary w-full" style={{ height: 36 }} onClick={() => void navigate({ to: "/login" })}>
          Continue to login
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Create your account. Minimum 8-character password.</p>
      {code === "INVALID_TOKEN" && (
        <NoticeDanger>This invite link is invalid, expired, or already used. Ask your admin for a new one.</NoticeDanger>
      )}
      {code === "USER_EXISTS" && (
        <NoticeDanger>An account with this email already exists. Ask your admin for a set-password link instead.</NoticeDanger>
      )}

      <Field label="Name" htmlFor="inv-name" className="field mb-3">
        <TextInput id="inv-name" type="text" placeholder="Your name" autoComplete="name" value={name} onChange={(v) => setName(v)} />
      </Field>

      <Field label="Password" htmlFor="inv-password" hint="At least 8 characters." error={tooShort ? "At least 8 characters." : undefined} className="field mb-3">
        <TextInput id="inv-password" type="password" placeholder="••••••••••••" autoComplete="new-password" value={password} onChange={(v) => { setPasswordValue(v); setConfirmError(null); }} />
      </Field>

      <Field label="Confirm password" htmlFor="inv-confirm" error={confirmError ?? undefined} className="field mb-4">
        <TextInput id="inv-confirm" type="password" placeholder="••••••••••••" autoComplete="new-password" value={confirm} onChange={(v) => { setConfirm(v); setConfirmError(null); }} />
      </Field>

      <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={!canSubmit}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

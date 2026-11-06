import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useSetPassword } from "../../lib/queries";
import { authErrorCode } from "../../lib/auth";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import { NoticeDanger } from "../ui/NoticeDanger";

// Verification-token password completion (/set-password?token=…). Two token
// kinds share this form: self-service reset tokens (better-auth native, 30
// minutes) and admin-issued set-password links (7 days). The server resolves
// either to the existing account and runs better-auth's native reset-password,
// which sets the password and revokes existing sessions — it establishes NO
// session cookie, so success requires a fresh sign-in. Workspace invitation
// links (/invite?token=…) are a different token kind on a separate surface.
export function SetPasswordForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const setPassword = useSetPassword();
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const canSubmit = password.length >= 8 && confirm.length > 0 && !tooShort && !confirmError;
  const code = authErrorCode(setPassword.error);
  const inlineError = setPassword.isError
    ? code === "INVALID_TOKEN"
      ? "This link is invalid, expired, or already used. Request a new reset link from sign in, or ask your admin for a new one."
      : setPassword.error?.message || "Could not set password. Try again."
    : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8 || password !== confirm) {
      if (password !== confirm) setConfirmError("Passwords do not match");
      return;
    }
    setPassword.mutate(
      { newPassword: password, token },
      {
        onSuccess: () => setDone(true),
      }
    );
  };

  if (done) {
    return (
      <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)", textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 9999, background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", margin: "0 auto 12px" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
        </div>
        <div className="text-sm font-medium mb-1" style={{ fontWeight: 500 }}>Password set — sign in with your new password</div>
        <p className="text-xs text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Your account is ready — no session was started, so sign in to continue.</p>
        <button className="btn btn-primary w-full" style={{ height: 36 }} onClick={() => navigate({ to: "/login" })}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      {inlineError && (
        <div role="alert"><NoticeDanger>{inlineError}</NoticeDanger></div>
      )}
      <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Set a password for your account. Minimum 8 characters. This link works once.</p>

      <Field label="Password" htmlFor="sp-password" hint="At least 8 characters." error={tooShort ? "At least 8 characters." : undefined} className="field mb-3">
        <TextInput id="sp-password" type="password" placeholder="••••••••••••" autoComplete="new-password" value={password} onChange={(v) => { setPasswordValue(v); setConfirmError(null); }} />
      </Field>

      <Field label="Confirm password" htmlFor="sp-confirm" error={confirmError ?? undefined} className="field mb-4">
        <TextInput id="sp-confirm" type="password" placeholder="••••••••••••" autoComplete="new-password" value={confirm} onChange={(v) => { setConfirm(v); setConfirmError(null); }} />
      </Field>

      <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={!canSubmit || setPassword.isPending}>
        {setPassword.isPending ? "Setting password…" : "Set password"}
      </button>
    </form>
  );
}

// A missing token cannot complete; the form is withheld.
export function InvalidTokenState() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <NoticeDanger>This link is invalid or has expired.</NoticeDanger>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>
        Password links are single-use. Request a new reset link from the sign-in page, or ask your admin for a new one.
      </p>
      <Link to="/login" className="btn btn-ghost w-full" style={{ height: 44, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        Back to sign in
      </Link>
    </div>
  );
}

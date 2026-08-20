import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSetPassword } from "../../lib/queries";

// Shared accept form for both token links: admin-issued set-password links
// (/set-password?token=…) and workspace invitation links (/invite?token=…).
// Both carry a Better Auth verification token; the server resolves it to the
// account (invite accept mints the member account), sets the password and
// establishes the session cookie. Tokens are single-use with 7d expiry.
export function SetPasswordForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const setPassword = useSetPassword();
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const canSubmit = password.length >= 8 && confirm.length > 0 && !tooShort && !confirmError;

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
        <div className="text-sm weight-500 mb-1" style={{ fontWeight: 500 }}>Password set — you're signed in</div>
        <p className="text-xs text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Welcome to Lexa.</p>
        <button className="btn btn-primary w-full" style={{ height: 36 }} onClick={() => navigate({ to: "/" })}>
          Continue to Lexa
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>Set a password for your account. Minimum 8 characters.</p>

      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field-label" htmlFor="sp-password">Password</label>
        <input
          id="sp-password"
          className="prop-input w-full"
          type="password"
          placeholder="••••••••••••"
          autoComplete="new-password"
          value={password}
          onChange={(e) => { setPasswordValue(e.target.value); setConfirmError(null); }}
        />
        <div className={tooShort ? "field-hint-danger" : "field-hint"}>{tooShort ? "At least 8 characters." : "At least 8 characters."}</div>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label className="field-label" htmlFor="sp-confirm">Confirm password</label>
        <input
          id="sp-confirm"
          className="prop-input w-full"
          type="password"
          placeholder="••••••••••••"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setConfirmError(null); }}
        />
        {confirmError && <div className="field-hint-danger">{confirmError}</div>}
      </div>

      <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={!canSubmit || setPassword.isPending}>
        {setPassword.isPending ? "Setting password…" : "Set password"}
      </button>
    </form>
  );
}

// Invalid / expired token state — form withheld. Tokens are single-use and
// expire after 7 days; only superadmins can issue fresh links.
export function InvalidTokenState() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <div className="notice notice-danger mb-4">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        <span>This link is invalid or has expired. Ask your admin for a new one.</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>
        Tokens are single-use and expire after 7 days. Your admin can send a fresh link from Workspace settings → Members → "Send set-password link".
      </p>
    </div>
  );
}

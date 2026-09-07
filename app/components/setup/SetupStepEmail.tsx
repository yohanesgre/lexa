import { useEffect, useRef, useState } from "react";
import { ArrowRight, Mail } from "lucide-react";
import { setSetupAdmin } from "../../lib/api";

// Step 0 — create the first superadmin account (email + password, hashed
// server-side via Better Auth; docs/API.md { email*, password* }). No email
// is sent; teammates join via workspace invites and set-password links.
export function SetupStepEmail({
  email,
  onEmailChange,
  isRemote,
  onDone,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  isRemote: boolean;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Mount focus without the autoFocus attribute (a11y: no programmatic
  // focus steal after page load).
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await setSetupAdmin(trimmed, password);
      onDone();
    } catch (err) {
      const e = err as Error & { code?: string | undefined };
      setError(
        e.code === "SETUP_LOCKED"
          ? "Setup is locked — the instance is already configured."
          : e.message || "Could not create the admin account. Is the server running?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Mail size={16} strokeWidth={1.5} className="text-lx-text-link" />
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Admin email</h2>
      </div>
      <p className="text-sm text-lx-text-secondary leading-5 mb-4">
        Create the first superadmin account. This email and password sign in to the workspace with full admin rights.
      </p>
      <label className="prop-label block mb-1.5" htmlFor="setup-email">Email address</label>
      <input
        id="setup-email"
        ref={emailRef}
        className="prop-input w-full"
        type="email"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
        placeholder="you@example.com"
        autoComplete="username"
      />
      <label className="prop-label block mb-1.5 mt-3" htmlFor="setup-password">Password</label>
      <div className="input-affix">
        <input
          id="setup-password"
          className="prop-input w-full"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
          placeholder="Minimum 8 characters"
          autoComplete="new-password"
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={showPassword ? "Hide password" : "Show password"}
          title={showPassword ? "Hide password" : "Show password"}
          onClick={() => setShowPassword((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            {showPassword ? (
              <>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M1 1l22 22" />
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
      </div>
      {error && <p className="text-xs text-lx-text-danger mt-2">{error}</p>}
      {isRemote && (
        <p className="text-xs text-lx-text-warning mt-3 leading-4">
          This account becomes the first superadmin. Keep the password safe — password resets require server access; teammates join via workspace invites and set-password links.
        </p>
      )}
      <div className="flex justify-end mt-5">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !email.trim() || password.length < 8}>
          Continue <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

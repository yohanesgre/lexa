import { useEffect, useRef, useState } from "react";
import { ArrowRight, Mail } from "lucide-react";
import { setSetupAdmin } from "../../lib/api";

// Step 0 — claim the first superadmin email. No email is sent; teammates
// join via workspace invites and set-password links.
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
    setError("");
    setBusy(true);
    try {
      await setSetupAdmin(trimmed);
      onDone();
    } catch {
      setError("Could not save the admin email. Is the server running?");
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
        The first person to log in with this email becomes an admin. They can invite teammates and manage settings.
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
      />
      {error && <p className="text-xs text-lx-text-danger mt-2">{error}</p>}
      {isRemote && (
        <p className="text-xs text-lx-text-warning mt-3 leading-4">
          This email becomes the first superadmin. Keep it reachable — no email sending is used; teammates join via workspace invites and set-password links.
        </p>
      )}
      <div className="flex justify-end mt-5">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !email.trim()}>
          Continue <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useSignIn } from "../../lib/queries";
import { NoticeDanger } from "../ui/NoticeDanger";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import { PasswordField } from "../ui/PasswordField";

// Same inline form as /login — wireframe device-login.html sign-in gate
// variant; keeps ?request&token in the URL so approval continues after login.
export function NotSignedInVariant() {
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        <Field label="Email" htmlFor="dl-email" className="field mb-3">
          <TextInput id="dl-email" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(v) => { setEmail(v); if (error) setError(null); }} />
        </Field>
        <div className="field mb-4">
          <label className="field-label" htmlFor="dl-password">Password</label>
          <PasswordField id="dl-password" value={password} onChange={(v) => { setPassword(v); if (error) setError(null); }} />
        </div>
        {error && <NoticeDanger>Invalid email or password.</NoticeDanger>}
        <button type="submit" className="btn btn-primary w-full" style={{ height: 36 }} disabled={signIn.isPending}>
          {signIn.isPending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
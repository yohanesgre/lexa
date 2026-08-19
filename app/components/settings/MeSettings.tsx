import { useEffect, useState } from "react";
import { useSession, useSessions, useRevokeSession, useUpdateMyName, useChangePassword } from "../../lib/queries";
import { formatRelative } from "./SettingsSections";
import type { SessionInfo } from "../../../shared/types";

// /settings/me — EVERY signed-in user. Own data only; nothing here is gated
// by role.
export function MeSettings() {
  const { data: session } = useSession();
  const user = session?.user;

  if (!user) return null;

  return (
    <main className="page-frame page-frame-narrow">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-6">User settings</h1>

      <ProfileSection />
      <PasswordSection />
      <SessionsSection currentSessionId={session?.session?.id ?? null} />
    </main>
  );
}

function ProfileSection() {
  const { data: session } = useSession();
  const user = session?.user;
  const updateMyName = useUpdateMyName();
  const [name, setName] = useState(user?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  if (!user) return null;
  const initial = user.name?.[0]?.toUpperCase() ?? "?";

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 80) {
      setError("Name must be 1-80 characters");
      return;
    }
    setError(null);
    updateMyName.mutate(trimmed, { onError: (err) => setError(err.message) });
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Profile</h2>
      <div className="card-panel card-panel--elevated mt-4">
        <div className="flex items-start gap-4 flex-wrap">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <div className="avatar" style={{ width: 48, height: 48, fontSize: 18 }}>{initial}</div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label" htmlFor="me-name">Name</label>
              <input id="me-name" className="prop-input w-full" value={name} onChange={(e) => { setName(e.target.value); if (error) setError(null); }} />
              <div className="field-hint">Initials avatar derives from the name. Save → PATCH /api/me; the user-menu trigger updates from the response.</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="me-email">Email</label>
              <div className="flex items-center gap-2">
                <input id="me-email" className="prop-input w-full" value={user.email} disabled style={{ opacity: 0.6 }} />
                <span className="text-xs text-lx-text-muted">read-only</span>
              </div>
              <div className="field-hint">Email is the login identity — changing it is a provisioning-level action (contact your admin).</div>
            </div>
          </div>
        </div>
        {error && <div className="field-hint-danger mt-3">{error}</div>}
        <div className="flex justify-end mt-4">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={updateMyName.isPending || name.trim() === user.name}>
            {updateMyName.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PasswordSection() {
  const changePassword = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const canSubmit = current.length > 0 && next.length >= 8 && confirm.length > 0 && !tooShort;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError("New passwords do not match");
      return;
    }
    setError(null);
    setSuccess(false);
    changePassword.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setConfirm("");
          setSuccess(true);
        },
        onError: (err) => setError(err.message),
      }
    );
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Password</h2>
      <form onSubmit={handleSubmit} className="card-panel card-panel--elevated mt-4" style={{ maxWidth: 560 }}>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="pw-current">Current password</label>
          <input id="pw-current" className="prop-input w-full" type="password" placeholder="••••••••••••" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setError(null); }} />
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="pw-new">New password</label>
          <input id="pw-new" className="prop-input w-full" type="password" placeholder="••••••••••••" autoComplete="new-password" value={next} onChange={(e) => { setNext(e.target.value); setError(null); }} />
          <div className={tooShort ? "field-hint-danger" : "field-hint"}>At least 8 characters.</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" className="prop-input w-full" type="password" placeholder="••••••••••••" autoComplete="new-password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(null); }} />
        </div>
        {error && <div className="field-hint-danger mt-2">{error}</div>}
        {success && <div className="field-hint mt-2" style={{ color: "var(--lx-text-success)" }}>Password updated. Other sessions stay valid — revoke them below.</div>}
        <div className="flex justify-end mt-4">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit || changePassword.isPending}>
            {changePassword.isPending ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </section>
  );
}

function SessionsSection({ currentSessionId }: { currentSessionId: string | null }) {
  const { data: sessions = [], isLoading, isError } = useSessions();
  const revoke = useRevokeSession();

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Sessions</h2>
        <span className="text-xs text-lx-text-muted">Own sessions only</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Every active sign-in on this account. Sessions last 7 days, sliding on activity. Revoking kills a session immediately; the current session can't be revoked from here (log out instead).
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load sessions.</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Device</th><th>IP</th><th>Signed in</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {sessions.map((s: SessionInfo) => {
                const isCurrent = s.id === currentSessionId;
                const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
                return (
                  <tr key={s.id} style={expired ? { opacity: 0.5 } : undefined}>
                    <td>
                      <div className="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
                        <span className="text-sm font-medium">{deviceLabel(s.userAgent)}</span>
                        {isCurrent && <span style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>this device</span>}
                      </div>
                    </td>
                    <td className="font-mono text-xs text-lx-text-secondary">{s.ipAddress ?? "—"}</td>
                    <td className="text-xs text-lx-text-secondary">{s.createdAt ? formatRelative(s.createdAt) : "—"}</td>
                    <td className="text-xs text-lx-text-secondary">{s.expiresAt ? (expired ? <span className="text-lx-text-muted">expired</span> : new Date(s.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {isCurrent ? (
                        <span className="text-xs text-lx-text-muted">Log out instead</span>
                      ) : expired ? (
                        <span className="text-xs text-lx-text-muted">—</span>
                      ) : (
                        <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => revoke.mutate(s.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/") ? "Edge" : ua.includes("firefox") ? "Firefox" : ua.includes("chrome") ? "Chrome" : ua.includes("safari") ? "Safari" : "Browser";
  const os = ua.includes("windows") ? "Windows" : ua.includes("mac os") || ua.includes("macintosh") ? "macOS" : ua.includes("android") ? "Android" : ua.includes("iphone") || ua.includes("ipad") ? "iOS" : ua.includes("linux") ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device";
}

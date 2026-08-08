import { useEffect, useRef, useState } from "react";
import { clientLxkLogout, clientLxkUser } from "../../lib/api";
import { useUpdateMyName } from "../../lib/queries";

// Identity from the lxk-user meta injected by the server (server/entry.ts).
// Held in state so the header + profile panel reflect a rename immediately.
// Local dev without Cf-Access has no meta → neutral fallback.
interface Identity {
  email: string;
  name: string;
  role?: "admin" | "member";
  createdAt?: string;
}

export function UserProfile() {
  const [identity, setIdentity] = useState<Identity>(() => clientLxkUser() ?? { name: "You", email: "" });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "profile">("menu");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const updateMyName = useUpdateMyName();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const logoutUrl = clientLxkLogout();
  const initial = identity.name[0]?.toUpperCase() ?? "?";
  const memberSince = identity.createdAt
    ? new Date(identity.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })
    : null;

  const toggle = () => {
    if (open) {
      setOpen(false);
      setView("menu");
    } else {
      setOpen(true);
    }
  };

  const openProfile = () => {
    setDraft(identity.name);
    setError(null);
    setView("profile");
  };

  const cancelEdit = () => {
    setDraft(identity.name);
    setError(null);
  };

  const handleSave = () => {
    const name = draft.trim();
    if (name === "" || name.length > 80) {
      setError("Name must be 1-80 characters");
      return;
    }
    updateMyName.mutate(name, {
      onSuccess: (user) => {
        setIdentity((prev) => ({ ...prev, name: user.name }));
        setDraft(user.name);
        setError(null);
      },
      onError: (err) => setError(err.message),
    });
  };

  const handleSignOut = () => {
    if (!logoutUrl) return;
    window.location.href = logoutUrl + "?return_to=" + encodeURIComponent(window.location.origin + "/");
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        className="nav-pill"
        style={{ gap: 8, padding: "0 8px 0 6px" }}
      >
        <div className="avatar" style={{ width: 20, height: 20, fontSize: 10 }}>{initial}</div>
        <span className="font-medium" style={{ lineHeight: 1 }}>{identity.name}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && view === "menu" && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 180, zIndex: 60 }}>
          <div className="dropdown-label">Account</div>
          <button type="button" className="dropdown-item" style={{ gap: 8, width: "100%", textAlign: "left" }} onClick={openProfile}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </button>
          <div className="dropdown-separator" />
          {logoutUrl && (
            <button type="button" className="dropdown-item" style={{ color: "var(--lx-text-danger)", gap: 8, width: "100%", textAlign: "left", border: "none", background: "none", font: "inherit", padding: "8px 12px", cursor: "pointer" }} onClick={handleSignOut}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          )}
        </div>
      )}

      {open && view === "profile" && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 280, zIndex: 60 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px 10px" }}>
            <div className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{initial}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="text-sm font-semibold text-lx-text-primary" style={{ lineHeight: 1.2, whiteSpace: "nowrap" }}>{identity.name}</span>
                {identity.role && (
                  <span className="text-xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11, flexShrink: 0 }}>
                    {identity.role === "admin" ? "Admin" : "Member"}
                  </span>
                )}
              </div>
              <div className="text-xs text-lx-text-muted" style={{ lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{identity.email}</div>
              {memberSince && <div className="text-xs text-lx-text-muted" style={{ lineHeight: 1.4 }}>Member since {memberSince}</div>}
            </div>
          </div>
          <div className="dropdown-separator" />
          <div className="dropdown-label" style={{ padding: "8px 10px 4px" }}>Display name</div>
          <div style={{ padding: "0 10px" }}>
            <input
              className="prop-input"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
              style={{ width: "100%" }}
            />
          </div>
          {error && <div className="field-hint-danger" style={{ padding: "0 10px" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 10px 6px" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={updateMyName.isPending}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

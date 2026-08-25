import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useSession, useSignOut, useTeams } from "../../lib/queries";

// Top-right profile menu (app-nav right cluster). Identity header + role-
// scoped settings entries + Log out. The old Settings nav link is gone — all
// settings entry points live here (and in the project switcher).
//
// Entry visibility is role-driven: User settings → everyone · Team settings →
// superadmin + team admins (renders the team they manage) · Workspace
// settings → superadmin only. Role source: users.role (superadmin|member) +
// team membership role (owner/admin = team admin; GET /api/teams returns the
// teams the caller administers).
export function UserMenu() {
  const { data: session, isLoading } = useSession();
  const { data: teams } = useTeams();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

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

  if (isLoading) return null;

  const user = session?.user ?? null;
  if (!user) {
    return (
      <Link to="/login" className="btn btn-primary" style={{ height: 28, padding: "0 14px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
        Log in
      </Link>
    );
  }

  const isSuperadmin = user.role === "superadmin";
  // GET /api/teams: own teams for team admins, all teams for superadmin,
  // empty (or 403) for plain members — any team row = admin authority.
  const isTeamAdmin = isSuperadmin || (teams && teams.length > 0);
  const roleLabel = isSuperadmin ? "superadmin" : isTeamAdmin ? "team admin" : "member";
  const initial = user.name?.[0]?.toUpperCase() ?? "?";

  const handleSignOut = () => {
    signOut.mutate(undefined, {
      onSuccess: () => navigate({ to: "/login", replace: true }),
    });
  };

  return (
    <div ref={ref} className="user-menu" style={{ position: "relative" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        className="nav-pill"
        style={{ gap: 8, padding: "0 8px 0 6px" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="avatar" style={{ width: 20, height: 20, fontSize: 10 }}>{initial}</div>
        <span className="weight-500" style={{ lineHeight: 1, fontWeight: 500 }}>{user.name}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 240, zIndex: 60 }} role="menu">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
            <div className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{initial}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-sm weight-600" style={{ lineHeight: 1.2, fontWeight: 600 }}>{user.name}</div>
              <div className="text-xs text-lx-text-muted" style={{ lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
            </div>
            <span style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11, flexShrink: 0 }}>{roleLabel}</span>
          </div>
          <div className="dropdown-separator" />
          <Link to="/settings/me" className="dropdown-item" style={{ height: 32, textDecoration: "none" }} onClick={() => setOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            <span className="text-sm color-secondary">User settings</span>
            
          </Link>
          {isTeamAdmin && (
            <Link to="/settings/team" className="dropdown-item" style={{ height: 32, textDecoration: "none" }} onClick={() => setOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
              <span className="text-sm color-secondary">Team settings</span>
              
            </Link>
          )}
          {isSuperadmin && (
            <Link to="/settings/workspace" className="dropdown-item" style={{ height: 32, textDecoration: "none" }} onClick={() => setOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>
              <span className="text-sm color-secondary">Workspace settings</span>
              
            </Link>
          )}
          <div className="dropdown-separator" />
          <button type="button" className="dropdown-item danger" style={{ gap: 8, width: "100%", textAlign: "left", border: "none", background: "none", font: "inherit", padding: "0 10px", cursor: "pointer", height: 32 }} onClick={handleSignOut} disabled={signOut.isPending}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            <span className="text-sm">Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
